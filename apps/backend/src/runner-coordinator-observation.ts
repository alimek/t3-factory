import { nativeHumanReplies } from "./coordinator-human-authority.ts";
import { retainRemoteWork } from "./coordinator-remote.ts";
import { settleCoordinatorWaits } from "./coordinator-conversation.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import {
  collectCoordination,
  type MemberObservation,
  type CoordinationObservation,
} from "./coordinator-evidence.ts";
import { newId } from "./ids.ts";
import { attention } from "./runner-attention.ts";
import { recoverOperation } from "./runner-effects.ts";

export function observeCoordinator(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  block: BlockRow,
  contextId: string | null,
) {
  return recoverOperation(
    Effect.gen(function* () {
      if (contextId !== run.context_id) throw Error("Coordinator context changed.");
      const collected = yield* collectCoordination(database, t3, run, block);
      const { activationId, result } = collected;
      const humanReplies = yield* Effect.tryPromise(() =>
        nativeHumanReplies(t3, run, block.thread_id!),
      ).pipe(Effect.catchCause(() => Effect.succeed([])));
      yield* database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* collected.isCurrent(sql))) return;
          const [report] = yield* sql<{
            execution_id: string;
          }>`SELECT execution_id FROM runtime_reports WHERE activation_id=${activationId}`;
          const time = result.evidence.observedAt;
          yield* retainRemoteWork(
            sql,
            activationId,
            result.remoteSources,
            result.remoteObservations,
            time,
          );
          yield* retainSafetyEvidence(sql, run, block, activationId, result);
          for (const member of result.members)
            yield* recordMember(
              sql,
              run,
              block,
              member,
              report ? null : activationId,
              time,
              collected.executions,
            );
          for (const reply of humanReplies) {
            // The membership trigger admits this activation update only with the retained reply.
            yield* sql`INSERT INTO coordinator_native_human_replies VALUES(${run.id},${block.thread_id},${reply.executionId},${reply.itemId}) ON CONFLICT DO NOTHING`;
            if (!report)
              yield* sql`UPDATE run_executions SET activation_id=${activationId} WHERE run_id=${run.id} AND thread_id=${block.thread_id} AND execution_id=${reply.executionId} AND activation_id IS NULL AND EXISTS(SELECT 1 FROM coordinator_waits w JOIN run_attention a ON a.id=w.attention_id JOIN run_executions old ON old.binding_id=w.target_binding_id AND old.execution_id=w.target_execution_id WHERE w.activation_id=${activationId} AND a.settled_at IS NULL AND old.ordinal<run_executions.ordinal)`;
          }
          yield* recordActivationState(sql, run, block, activationId, result, !!report);
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        }),
      );
    }),
    () =>
      database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return;
          yield* sql`UPDATE run_blocks SET freshness='stale',problem='Coordinator evidence unavailable.' WHERE run_id=${run.id} AND block_id=${block.block_id}`;
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        }),
      ),
  );
}

function recordMember(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  member: MemberObservation,
  activationId: string | null,
  time: string,
  executions: readonly { thread_id: string; execution_id: string; activation_id: string | null }[],
) {
  return Effect.gen(function* () {
    const [parent] = yield* sql<{
      id: string;
    }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${member.parentThreadId}`;
    yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,parent_binding_id) VALUES(${yield* newId},${run.id},${block.block_id},${run.environment_id},${member.threadId},${member.role},${parent?.id ?? null}) ON CONFLICT(run_id,environment_id,thread_id) DO NOTHING`;
    const [binding] = yield* sql<{
      id: string;
      block_id: string;
    }>`SELECT id,block_id FROM run_thread_bindings WHERE run_id=${run.id} AND environment_id=${run.environment_id} AND thread_id=${member.threadId}`;
    if (binding!.block_id !== block.block_id)
      throw Error("Thread already belongs to another activation.");
    yield* sql`UPDATE run_thread_bindings SET link=${member.observation.link},parent_binding_id=COALESCE(parent_binding_id,${parent?.id ?? null}),role=CASE WHEN role='descendant' AND ${member.role}='worker' THEN 'worker' ELSE role END WHERE id=${binding!.id}`;
    yield* attention(
      sql,
      run,
      { block_id: block.block_id, bindingId: binding!.id },
      member.observation.activeRunId ?? member.observation.latestRunId ?? "",
      "native-request",
      member.observation.pendingRequestCount > 0,
      time,
    );
    for (const execution of member.observation.recentRuns) {
      const membership = executions.some(
        (e) =>
          e.thread_id === member.threadId &&
          e.execution_id === execution.runId &&
          e.activation_id === activationId,
      )
        ? activationId
        : null;
      const problem = ["failed", "cancelled", "interrupted"].includes(execution.status)
        ? "execution-failed"
        : null;
      const [previous] = yield* sql<{
        engine_status: string;
      }>`SELECT engine_status FROM run_executions WHERE run_id=${run.id} AND thread_id=${member.threadId} AND execution_id=${execution.runId}`;
      yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,binding_id,activation_id,engine_status,ordinal,observed_at,problem,native_request_count) VALUES(${run.id},${block.block_id},${member.threadId},${execution.runId},${binding!.id},${membership},${execution.status},${execution.ordinal ?? null},${time},${problem},${member.observation.pendingRequestCount}) ON CONFLICT(run_id,thread_id,execution_id) DO UPDATE SET activation_id=COALESCE(run_executions.activation_id,excluded.activation_id),engine_status=excluded.engine_status,ordinal=COALESCE(excluded.ordinal,run_executions.ordinal),observed_at=excluded.observed_at,problem=excluded.problem,native_request_count=excluded.native_request_count`;
      yield* attention(
        sql,
        run,
        { block_id: block.block_id, bindingId: binding!.id },
        execution.runId,
        "execution-failed",
        problem === "execution-failed",
        time,
      );
      if (previous?.engine_status !== execution.status)
        yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,observed_at,engine_status) VALUES(${run.id},${block.block_id},${execution.runId},${binding!.id},'execution-observed',${yield* newId},${time},${execution.status})`;
    }
  });
}

function blockState(problem: string | null, finished: boolean) {
  if (problem === "missing-report" || problem === "execution-failed") return "error";
  return finished ? "finished" : "working";
}

/** Observation resumes `waiting` only after the wait itself has settled. */
function nextBlockState(
  block: BlockRow,
  problem: string | null,
  released: boolean,
  waiting: boolean,
) {
  const observed = blockState(problem, released);
  return block.state === "waiting" && waiting && observed === "working" ? "waiting" : observed;
}

function recordActivationState(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  activationId: string,
  result: CoordinationObservation,
  report: boolean,
) {
  return Effect.gen(function* () {
    const time = result.evidence.observedAt;
    const parent = result.members[0]!.observation;
    const latestId = parent.activeRunId ?? parent.latestRunId;
    const latest = parent.recentRuns.find((r) => r.runId === latestId);
    yield* settleCoordinatorWaits(sql, run.id, block.block_id, time);
    const waits =
      yield* sql`SELECT w.id FROM coordinator_waits w JOIN run_attention a ON a.id=w.attention_id WHERE w.activation_id=${activationId} AND ((w.parent_execution_id=${latestId ?? ""} AND NOT EXISTS(SELECT 1 FROM run_executions old JOIN run_executions next ON next.binding_id=old.binding_id AND next.ordinal>old.ordinal WHERE old.binding_id=w.target_binding_id AND old.execution_id=w.target_execution_id AND next.activation_id=old.activation_id)) OR a.settled_at IS NULL)`;
    const phase = report ? "reported" : waits.length > 0 ? "waiting-worker" : "assessing";
    const completedAssessment = phase === "assessing" && latest?.status === "completed";
    const problem = result.problem ?? (completedAssessment ? "missing-report" : null);
    yield* attention(
      sql,
      run,
      block,
      latestId ?? block.execution_id!,
      "missing-report",
      completedAssessment,
      time,
    );
    yield* checkpointAttention(sql, run, block, latestId, problem, time);
    if (problem === "missing-report")
      yield* sql`UPDATE run_executions SET problem='missing-report' WHERE run_id=${run.id} AND thread_id=${block.thread_id} AND execution_id=${latestId!}`;
    yield* sql`UPDATE run_activations SET phase=CASE WHEN phase='finished' THEN phase ELSE ${phase} END,evidence_json=${JSON.stringify(result.evidence)},coverage=${result.evidence.release ? "local-bounded" : "unverified"},problem=${problem} WHERE id=${activationId}`;
    yield* sql`UPDATE run_blocks SET execution_id=${latestId ?? block.execution_id},engine_status=${latest?.status ?? null},freshness='fresh',observed_at=${time},pending_request_count=${parent.pendingRequestCount},problem=${problem},state=${nextBlockState(block, problem, !!report && result.evidence.release, waits.length > 0)} WHERE run_id=${run.id} AND block_id=${block.block_id}`;
  });
}

function retainSafetyEvidence(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  activationId: string,
  result: CoordinationObservation,
) {
  return Effect.gen(function* () {
    for (const source of result.sources)
      yield* sql`INSERT INTO coordinator_native_items(activation_id,thread_id,item_id,execution_id,fingerprint) VALUES(${activationId},${source.threadId},${source.itemId},${source.executionId},${source.fingerprint}) ON CONFLICT DO NOTHING`;
    for (const member of result.unobserved) {
      const [parent] = yield* sql<{
        id: string;
      }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${member.parentThreadId}`;
      yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,parent_binding_id) VALUES(${yield* newId},${run.id},${block.block_id},${run.environment_id},${member.threadId},'descendant',${parent?.id ?? null}) ON CONFLICT DO NOTHING`;
    }
  });
}

function checkpointAttention(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  executionId: string | null | undefined,
  problem: string | null,
  time: string,
) {
  return problem === "Unauthorized post-checkpoint work requires attention."
    ? attention(sql, run, block, executionId ?? block.execution_id!, "report-problem", true, time)
    : Effect.void;
}

import { recoverOperation } from "./runner-effects.ts";
import { newId } from "./ids.ts";
import { conversationReportInstructions } from "./runner-handoffs.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter, SendPayload } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { gatherClosureAttempt } from "./runner-closure.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { failure } from "./result.ts";
import { now } from "./time.ts";
export function recoveryRows(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      attention_id: string;
      block_id: string;
      source_execution_id: string;
      intent_id: string;
      requested_at: string;
      settled_at: string | null;
      result_json: string | null;
    }>`SELECT r.*,i.result_json FROM report_recoveries r JOIN operation_intents i ON i.id=r.intent_id WHERE r.run_id=${id}`;
    return rows.map((r) => ({
      attentionId: r.attention_id,
      blockId: r.block_id,
      sourceExecutionId: r.source_execution_id,
      intentId: r.intent_id,
      requestedAt: r.requested_at,
      settledAt: r.settled_at,
      executionId: r.result_json
        ? (
            JSON.parse(r.result_json) as {
              runId: string;
            }
          ).runId
        : null,
    }));
  });
}
/** Fresh external evidence is separate from the local transaction/generation check. */
export function recoveryFrontier(
  t3: T3Adapter,
  runRow: RunRow,
  blockId: string,
  threadId: string,
  executionId: string,
  requireIdleFrontier = true,
) {
  return Effect.gen(function* () {
    const attempt = yield* gatherClosureAttempt(
      {
        runId: runRow.id,
        generation: runRow.generation,
        gateOpen: true,
        contextId: runRow.context_id,
      },
      t3,
      { ...runTarget(runRow), blocks: [{ blockId, threadId, recorded: [{ runId: executionId }] }] },
    );
    const f = attempt.frontier[0]!;
    return (
      f.pendingRequestCount === 0 &&
      f.executions.some((e) => e.executionId === executionId && e.status === "completed") &&
      (!requireIdleFrontier ||
        (f.latestRunId === executionId &&
          f.activeRunId === null &&
          f.queueNextCursor === null &&
          f.queuedRunIds.length === 0 &&
          f.executions.every((e) => e.status === "completed")))
    );
  });
}
export function openRunnerRecovery(
  database: RunnerDatabase,
  lifecycle: RunnerLifecycle,
  t3: T3Adapter,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  const { run, row, mutate, runHeldUnderContext } = database;
  function requestReport(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
      const found = yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{
            run_id: string;
          }>`SELECT run_id FROM run_attention WHERE id=${id}`)[0];
        }),
      );
      if (!found) return failure("not_found", "This missing-report Problem does not exist.");
      const detail = yield* lifecycle.getRun(found.run_id);
      if (!detail.ok) return detail;
      if (detail.value.recoveries.some((r) => r.attentionId === id)) return detail;
      const a = detail.value.attention.find((a) => a.id === id)!;
      const b = detail.value.blocks.find((b) => b.blockId === a.blockId)!;
      const current = yield* row(found.run_id);
      if (
        !current ||
        a.kind !== "missing-report" ||
        a.settledAt ||
        b.executionId !== a.executionId ||
        !b.threadId
      )
        return failure(
          "conflict",
          "This missing-report obligation is no longer eligible. Refresh the Run.",
        );
      const threadId = b.threadId;
      const preflight = yield* recoverOperation(
        Effect.gen(function* () {
          if (
            (yield* liveContextId()) !== current.context_id ||
            !(yield* recoveryFrontier(t3, current, a.blockId, threadId, a.executionId))
          )
            return failure(
              "conflict",
              "Recovery requires the original completed execution, no newer or queued work, and no pending native requests.",
            );
          return { ok: true as const, value: undefined };
        }),
        () =>
          Effect.succeed(
            failure(
              "conflict",
              "Fresh execution, queue and native-request evidence is unavailable. Refresh before requesting a report.",
            ),
          ),
      );
      if (!preflight.ok) return preflight;
      const accepted = yield* mutate(current.id, (sql) =>
        Effect.gen(function* () {
          const existing =
            yield* sql`SELECT attention_id FROM report_recoveries WHERE attention_id=${id}`;
          if (existing.length) return { ok: true as const, value: undefined };
          if (!(yield* runHeldUnderContext(sql, current, true)))
            return failure("conflict", "The Run is stopped, closed, or its authorization changed.");
          const eligible =
            yield* sql`SELECT r.id FROM runs r JOIN run_attention a ON a.run_id=r.id JOIN run_blocks b ON b.run_id=r.id AND b.block_id=a.block_id JOIN run_executions e ON e.run_id=r.id AND e.block_id=a.block_id AND e.execution_id=a.execution_id
        WHERE r.id=${current.id} AND r.generation=${detail.value.generation} AND a.id=${id} AND a.settled_at IS NULL AND b.execution_id=a.execution_id AND e.engine_status='completed' AND e.problem='missing-report' AND e.thread_id=${threadId} AND e.report_status IS NULL
        AND NOT EXISTS(SELECT 1 FROM runtime_reports WHERE run_id=r.id AND block_id=a.block_id AND execution_id=a.execution_id)
        AND NOT EXISTS(SELECT 1 FROM operation_intents WHERE run_id=r.id AND block_id=a.block_id AND state NOT IN ('acknowledged','cancelled'))`;
          if (!eligible.length)
            return failure(
              "conflict",
              "The Run changed or has competing work. Refresh before requesting a report.",
            );
          const intentId = yield* newId,
            key = yield* newId,
            time = yield* now;
          const { definitions } = current;
          const exits = definitions.flow.graph.blocks.find(
            (block) => block.id === a.blockId,
          )!.exits;
          const payload: SendPayload = {
            environmentId: current.environment_id,
            threadId: b.threadId!,
            mode: "queue",
            clientRequestId: key,
            message:
              "Factory Request report: assess the existing work without repeating the task. If questions you asked the user are still unanswered, report waiting with what you still need instead of forcing completion; report finished only when the task or discussion is actually complete. Report for this new execution only; never backdate an earlier report.\n\n" +
              conversationReportInstructions(exits),
          };
          const body = JSON.stringify(payload);
          yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id) VALUES(${intentId},${current.id},${a.blockId},'send',${"recovery:" + id},${JSON.stringify({ ...runTarget(current), blockId: a.blockId, threadId: b.threadId })},${key},${body},${fingerprint(body)},${current.context_id})`;
          yield* sql`INSERT INTO report_recoveries(attention_id,run_id,block_id,source_execution_id,intent_id,requested_at) VALUES(${id},${current.id},${a.blockId},${a.executionId},${intentId},${time})`;
          yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${current.id},${a.blockId},${a.executionId},'report-recovery-requested',${"recovery:" + id},${intentId},${time})`;
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${current.id}`;
          return { ok: true as const, value: undefined };
        }),
      );
      if (!accepted.ok) return accepted;
      yield* lifecycle.drive(current.id, "dispatch");
      return yield* lifecycle.getRun(current.id);
    });
  }
  return { requestReport };
}
export function recoveryDispatchGeneration(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: import("./runner-types.ts").IntentRow,
) {
  return Effect.gen(function* () {
    if (!intent.cause.startsWith("recovery:") || intent.state !== "pending") return undefined;
    const current = yield* database.row(runRow.id);
    if (!current) return null;
    const target = JSON.parse(intent.target_json) as {
      threadId: string;
    };
    const recovery = yield* database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{
          source_execution_id: string;
        }>`SELECT source_execution_id FROM report_recoveries WHERE intent_id=${intent.id}`)[0];
      }),
    );
    if (
      !recovery ||
      !(yield* recoveryFrontier(
        t3,
        current,
        intent.block_id,
        target.threadId,
        recovery.source_execution_id,
      ))
    ) {
      yield* database.problem(
        intent,
        "Recovery target has new activity or pending attention; the accepted request remains unsent.",
      );
      return null;
    }
    return current.generation;
  });
}

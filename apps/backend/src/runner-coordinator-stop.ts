import { settleStoppedRootCommands } from "./run-root-stop.ts";
import { localRetention, localClosureRetention } from "./coordinator-local-observations.ts";
import { collectPeerStop } from "./coordinator-peer-stop.ts";
import { readRemoteReferences, retainRemoteWork, observeRemoteWork } from "./coordinator-remote.ts";
import { remoteInputRetention } from "./coordinator-remote-input.ts";
import { nativeRetention } from "./coordinator-native-obligations.ts";
import { requestFrontierStop } from "./run-root-stop.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import {
  collectStopMembers,
  stopAggregate,
  type StopMember,
  type StopSource,
} from "./coordinator-stop-evidence.ts";
import { gatherClosureAttempt, confirmClosure, type ClosureAttempt } from "./runner-closure.ts";
import { recoverOperation } from "./runner-effects.ts";
import { isTerminal, runTarget } from "./runner-utils.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";

function terminalFrontier(f: ClosureAttempt["frontier"][number]) {
  return (
    !f.activeRunId &&
    !!f.latestRunId &&
    f.executions.some((e) => e.executionId === f.latestRunId) &&
    !f.queuedRunIds.length &&
    f.queueNextCursor === null &&
    f.pendingRequestCount === 0 &&
    f.executions.every((e) => isTerminal(e.status))
  );
}
export function reconcileCoordinatorStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  unavailable: () => Effect.Effect<void, unknown>,
  root: {
    frontier: NonNullable<import("@t3-factory/contracts").RunClosure["rootFrontier"]>;
    complete: boolean;
    trustedThreads: readonly string[];
  },
) {
  return recoverOperation(
    Effect.gen(function* () {
      const saved = yield* database.transaction((sql) =>
        Effect.gen(function* () {
          const members =
            yield* sql<StopMember>`SELECT b.thread_id AS threadId,b.block_id AS blockId,b.role,COALESCE(p.thread_id,(SELECT parent_thread_id FROM run_worker_activations w WHERE w.binding_id=b.id LIMIT 1)) AS parentThreadId FROM run_thread_bindings b LEFT JOIN run_thread_bindings p ON p.id=b.parent_binding_id WHERE b.run_id=${run.id}`;
          const native =
            yield* sql<StopSource>`SELECT DISTINCT n.thread_id AS threadId,n.item_id AS itemId,n.execution_id AS executionId,n.fingerprint FROM coordinator_native_items n JOIN run_activations a ON a.id=n.activation_id WHERE a.run_id=${run.id} AND NOT EXISTS (
              SELECT 1 FROM coordinator_remote_work w WHERE w.activation_id=n.activation_id
              AND w.parent_thread_id=n.thread_id AND w.source_item_id=n.item_id
              AND w.source_execution_id=n.execution_id AND w.source_fingerprint=n.fingerprint
              AND w.resolved=1 AND w.task_id IS NULL AND w.thread_id IS NULL
            )`;
          const executions = yield* sql<{
            thread_id: string;
            execution_id: string;
          }>`SELECT thread_id,execution_id FROM run_executions WHERE run_id=${run.id}
          UNION SELECT thread_id,execution_id FROM coordinator_native_obligations WHERE run_id=${run.id}`;
          return { members, native, executions };
        }),
      );
      const discovered = yield* Effect.tryPromise(() =>
        collectStopMembers(
          t3,
          run,
          saved.members.filter((m) => root.trustedThreads.includes(m.threadId)),
          saved.native,
          (blockId) => nativeRetention(database, run, blockId),
          (blockId) => localRetention(database, run, blockId),
        ),
      );
      const executions = [...saved.executions, ...discovered.references];
      yield* retainStopMembers(database, run, discovered);
      const remoteWork = yield* database.transaction((sql) => readRemoteReferences(sql, run.id));
      const remoteObservations = yield* Effect.tryPromise(() =>
        observeRemoteWork(
          t3,
          run,
          discovered.remoteSources,
          remoteWork,
          remoteInputRetention(database, run),
        ),
      );
      yield* database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return;
          for (const activationId of new Set(remoteWork.map((w) => w.activationId)))
            yield* retainRemoteWork(sql, activationId, [], remoteObservations, yield* now);
          for (const source of discovered.remoteSources) {
            const [activation] = yield* sql<{
              id: string;
            }>`SELECT a.id FROM run_activations a JOIN run_thread_bindings b ON b.run_id=a.run_id AND b.block_id=a.block_id WHERE a.run_id=${run.id} AND b.thread_id=${source.parentThreadId} ORDER BY a.rowid DESC LIMIT 1`;
            if (activation)
              yield* retainRemoteWork(sql, activation.id, [source], remoteObservations, yield* now);
          }
        }),
      );
      const frontiers: ClosureAttempt["frontier"][number][] = [];
      const peers = yield* Effect.tryPromise(() => collectPeerStop(database, t3, run, remoteWork));
      frontiers.push(...peers.frontier);
      let complete = peers.complete && root.complete;
      let observed = true;
      for (const member of discovered.members) {
        const attempt = yield* recoverOperation(
          gatherClosureAttempt(
            {
              runId: run.id,
              generation: run.generation,
              contextId: run.context_id,
              gateOpen: false,
            },
            t3,
            {
              ...runTarget(run),
              blocks: [
                {
                  ...member,
                  recorded: executions
                    .filter((e) => e.thread_id === member.threadId)
                    .map((e) => ({ runId: e.execution_id })),
                },
              ],
            },
            localClosureRetention(database, run),
          ),
          () => Effect.succeed(null),
        );
        if (!attempt) {
          observed = false;
          complete = false;
          const unresolved = {
            ...member,
            activeRunId: null,
            latestRunId: null,
            executions: executions
              .filter((e) => e.thread_id === member.threadId)
              .map((e) => ({
                executionId: e.execution_id,
                status: "unknown",
                ordinal: null,
                sourceAt: null,
              })),
            queuedRunIds: [],
          };
          yield* requestFrontierStop(database, t3, run, unresolved);
          const queue = yield* Effect.tryPromise(() =>
            t3.readQueue(runTarget(run), member.threadId).catch(() => null),
          );
          if (queue?.threadId === member.threadId)
            for (const queued of queue.queuedRunIds)
              yield* requestFrontierStop(database, t3, run, unresolved, queued);
          continue;
        }
        const frontier = attempt.frontier[0]!;
        frontiers.push(frontier);
        yield* retainStopExecutions(database, run, frontier);
        yield* requestFrontierStop(database, t3, run, frontier);
        for (const queued of frontier.queuedRunIds)
          yield* requestFrontierStop(database, t3, run, frontier, queued);
        complete &&= terminalFrontier(frontier);
        if (terminalFrontier(frontier))
          complete &&= yield* Effect.tryPromise(() =>
            stopAggregate(t3, run, member.threadId, frontier.latestRunId),
          );
      }
      // Closing in this pass would reuse observations taken before external effects.
      // A fresh sweep must observe every durable tree intent and all launch/send outcomes.
      yield* database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return;
          const time = yield* now;
          yield* sql`UPDATE run_blocks SET freshness=${observed ? "fresh" : "stale"},problem='Stop awaiting fresh parent, worker and descendant confirmation.' WHERE run_id=${run.id} AND thread_id IS NOT NULL`;
          const [current] = yield* sql<{
            generation: number;
          }>`SELECT generation FROM runs WHERE id=${run.id}`;
          if (!complete || current?.generation !== run.generation) return;
          yield* settleStoppedRootCommands(sql, run.id, time);
          const pending =
            yield* sql`SELECT id FROM operation_intents WHERE run_id=${run.id} AND state NOT IN ('acknowledged','cancelled')`;
          if (pending.length) return;
          const attempt = {
            runId: run.id,
            generation: run.generation,
            contextId: run.context_id,
            gateOpen: false,
            frontier: frontiers,
            rootFrontier: root.frontier,
          };
          if (!(yield* confirmClosure(sql, database.owner.token, attempt, "stopped"))) return;
          yield* sql`UPDATE run_blocks SET state=CASE WHEN state IN ('not-started','finished') THEN state ELSE 'stopped' END,problem=NULL WHERE run_id=${run.id}`;
          yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='cancelled-on-Stop' WHERE run_id=${run.id} AND settled_at IS NULL`;
        }),
      );
    }),
    unavailable,
  );
}

function retainStopMembers(
  database: RunnerDatabase,
  run: RunRow,
  discovered: Awaited<ReturnType<typeof collectStopMembers>>,
) {
  return database.mutate(run.id, (sql) =>
    Effect.gen(function* () {
      if (!(yield* database.runHeldUnderContext(sql, run))) return;
      for (const member of discovered.candidates) {
        const [parent] = yield* sql<{
          id: string;
        }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${member.parentThreadId}`;
        if (!parent) continue;
        if (discovered.members.some((m) => m.threadId === member.threadId))
          yield* sql`UPDATE run_thread_bindings SET parent_binding_id=COALESCE(parent_binding_id,${parent.id}) WHERE run_id=${run.id} AND thread_id=${member.threadId}`;
        const inserted =
          yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,parent_binding_id) VALUES(${yield* newId},${run.id},${member.blockId},${run.environment_id},${member.threadId},'descendant',${parent.id}) ON CONFLICT DO NOTHING RETURNING id`;
        if (inserted.length) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
      }
      for (const source of discovered.native) {
        const inserted =
          yield* sql`INSERT INTO coordinator_native_items(activation_id,thread_id,item_id,execution_id,fingerprint) SELECT a.id,${source.threadId},${source.itemId},${source.executionId},${source.fingerprint} FROM run_activations a JOIN run_thread_bindings b ON b.run_id=a.run_id AND b.block_id=a.block_id WHERE b.run_id=${run.id} AND b.thread_id=${source.threadId} ORDER BY a.rowid DESC LIMIT 1 ON CONFLICT DO NOTHING RETURNING item_id`;
        if (inserted.length) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
      }
    }),
  );
}

function retainStopExecutions(
  database: RunnerDatabase,
  run: RunRow,
  frontier: ClosureAttempt["frontier"][number],
) {
  return database.mutate(run.id, (sql) =>
    Effect.gen(function* () {
      if (!(yield* database.runHeldUnderContext(sql, run))) return;
      const [binding] = yield* sql<{
        id: string;
      }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${frontier.threadId}`;
      if (!binding) return;
      const executions = [
        ...frontier.executions,
        ...frontier.queuedRunIds
          .filter((id) => !frontier.executions.some((e) => e.executionId === id))
          .map((executionId) => ({ executionId, status: "queued", ordinal: null, sourceAt: null })),
      ];
      for (const execution of executions) {
        const inserted =
          yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,binding_id,engine_status,observed_at,ordinal,native_request_count) VALUES(${run.id},${frontier.blockId},${frontier.threadId},${execution.executionId},${binding.id},${execution.status},${frontier.executionObservedAt},${execution.ordinal},${frontier.pendingRequestCount}) ON CONFLICT DO NOTHING RETURNING execution_id`;
        if (inserted.length) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        yield* sql`UPDATE run_executions SET engine_status=${execution.status},observed_at=${frontier.executionObservedAt},native_request_count=${frontier.pendingRequestCount} WHERE run_id=${run.id} AND thread_id=${frontier.threadId} AND execution_id=${execution.executionId}`;
      }
    }),
  );
}

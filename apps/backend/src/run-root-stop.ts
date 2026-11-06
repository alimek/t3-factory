import type * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import type { ClosureAttempt } from "./runner-closure.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { recoverOperation } from "./runner-effects.ts";

/** Stops one observed frontier member's tree, or cancels one of its queued executions. */
export function requestFrontierStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  frontier: Pick<ClosureAttempt["frontier"][number], "threadId" | "executions" | "queuedRunIds">,
  queuedRunId?: string,
  peerEnvironmentId?: string,
) {
  return requestRootStop(
    database,
    t3,
    run,
    frontier.threadId,
    [...frontier.executions.map((e) => e.executionId), ...frontier.queuedRunIds],
    queuedRunId,
    peerEnvironmentId,
  );
}

/** Tree Stop deliberately has no execution fence: the native API stops a thread tree. */
export function requestRootStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  executionIds: readonly string[],
  queuedId?: string,
  peerEnvironmentId?: string,
) {
  return Effect.gen(function* () {
    if (run.closed_at) return;
    const retained = yield* database.transaction((sql) =>
      peerEnvironmentId
        ? sql<{
            reference: string;
          }>`SELECT reference FROM coordinator_peer_obligations WHERE run_id=${run.id} AND environment_id=${peerEnvironmentId} AND thread_id=${threadId} AND kind='execution'`
        : sql<{
            reference: string;
          }>`SELECT reference FROM run_root_obligations WHERE run_id=${run.id} AND thread_id=${threadId} AND kind='execution'`,
    );
    const knownIds = [...executionIds, ...retained.map((r) => r.reference)];
    const localCause = queuedId
      ? `cancel:${threadId}:${queuedId}`
      : `tree:${threadId}:${fingerprint(JSON.stringify([...new Set(knownIds)].sort()))}`;
    const cause = JSON.stringify([peerEnvironmentId ?? run.environment_id, localCause]);
    const target = { ...runTarget(run), ...(peerEnvironmentId ? { peerEnvironmentId } : {}) };
    const payload = queuedId
      ? { threadId, queuedRunId: queuedId }
      : { threadId, clientRequestId: fingerprint(`${run.id}:${cause}`) };
    const reserved = yield* database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, run))) return false;
        const held =
          yield* sql`SELECT id FROM runs WHERE id=${run.id} AND gate_open=0 AND stop_requested_at IS NOT NULL`;
        if (!held.length) return false;
        const rows =
          yield* sql`INSERT INTO run_root_stop_intents(run_id,cause,thread_id,payload_json,state) VALUES(${run.id},${cause},${threadId},${JSON.stringify(payload)},'reserved') ON CONFLICT DO NOTHING RETURNING cause`;
        if (rows.length) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        return rows.length > 0;
      }),
    );
    if (!reserved) return;
    yield* recoverOperation(
      Effect.gen(function* () {
        const support = yield* Effect.tryPromise(() =>
          t3.inspectStopSupport(target, queuedId ? "cancel" : "tree"),
        );
        if (!support.supported) return;
        if (queuedId)
          yield* Effect.tryPromise(() =>
            t3.cancelQueued(target, { threadId, queuedRunId: queuedId }),
          );
        else
          yield* Effect.tryPromise(() =>
            t3.stopOwnedTree(target, {
              threadId,
              clientRequestId: fingerprint(`${run.id}:${cause}`),
            }),
          );
      }),
      () => Effect.void,
    );
    yield* database.mutate(
      run.id,
      (sql) =>
        sql`UPDATE run_root_stop_intents SET state='uncertain' WHERE run_id=${run.id} AND cause=${cause} AND state='reserved'`,
    );
  });
}

/** Only call under the closure transaction after fresh full Root termination and generation validation. */
export function settleStoppedRootCommands(sql: SqlClient.SqlClient, runId: string, time: string) {
  return Effect.gen(function* () {
    const cancelled = yield* sql<{
      id: string;
      block_id: string;
    }>`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem='cancelled-on-Stop',reconciled_at=${time} WHERE run_id=${runId} AND state IN ('pending','reserved') AND id IN (SELECT intent_id FROM run_coordinator_commands WHERE run_id=${runId} AND state IN ('pending','issued')) RETURNING id,block_id`;
    for (const intent of cancelled)
      yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runId},${intent.block_id},'operation-cancelled',${"cancelled:" + intent.id},${intent.id},${time}) ON CONFLICT DO NOTHING`;
    yield* sql`UPDATE run_coordinator_commands SET cancelled_at=COALESCE(cancelled_at,${time}) WHERE run_id=${runId} AND state!='accepted'`;
  });
}

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RemoteWork } from "@t3-factory/contracts";
import { now } from "./time.ts";
import type { DelegationActivity, NativeRemoteTask } from "./adapters/delegation-activity.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RemoteWorkObservation } from "./adapters/remote-work.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
export interface RemoteSource extends NativeRemoteTask {
  parentThreadId: string;
}
export const REMOTE_HOLD =
  "Remote work remains unresolved. This T3 version cannot verify later replies or complete remote work safely.";

export function readRemoteReferences(sql: SqlClient.SqlClient, runId: string, blockId?: string) {
  return Effect.map(
    sql<
      Omit<RemoteWork, "available"> & { available: number }
    >`SELECT w.activation_id AS activationId,w.parent_thread_id AS parentThreadId,w.source_item_id AS sourceItemId,w.source_execution_id AS sourceExecutionId,c.environment_id AS sourceEnvironmentId,w.task_id AS taskId,w.environment_id AS environmentId,w.thread_id AS threadId,w.label,w.status,w.available,w.pending_request_count AS pendingRequestCount FROM coordinator_remote_work w JOIN run_activations a ON a.id=w.activation_id JOIN runs r ON r.id=a.run_id JOIN t3_authorization_contexts c ON c.id=r.context_id WHERE w.resolved=0 AND a.run_id=${runId} AND (${blockId ?? null} IS NULL OR a.block_id=${blockId ?? null}) ORDER BY w.rowid`,
    (rows) => rows.map((row) => ({ ...row, available: row.available === 1 })),
  );
}
export async function observeRemoteWork(
  t3: T3Adapter,
  run: RunRow,
  sources: readonly RemoteSource[],
  saved: readonly RemoteWork[],
  retainInput: (observation: RemoteWorkObservation) => Promise<void>,
) {
  const targets = new Map(saved.map((s) => [JSON.stringify([s.environmentId, s.threadId]), s]));
  for (const source of sources)
    targets.set(JSON.stringify([source.remote.environmentId, source.remote.threadId]), {
      ...source.remote,
      activationId: "",
      sourceItemId: source.itemId,
      sourceExecutionId: source.parentRunId,
      parentThreadId: source.parentThreadId,
      sourceEnvironmentId: run.environment_id,
      available: false,
      pendingRequestCount: null,
    });
  return Promise.all(
    [...targets.values()]
      .filter((remote) => remote.threadId !== null)
      .map(async (remote) => {
        const observation = await t3.readRemoteWork(runTarget(run), {
          environmentId: remote.environmentId,
          threadId: remote.threadId!,
        });
        if (
          observation.environmentId !== remote.environmentId ||
          observation.threadId !== remote.threadId
        )
          throw Error("Remote observation scope changed.");
        await retainInput(observation);
        return observation;
      }),
  );
}
export function retainRemoteWork(
  sql: SqlClient.SqlClient,
  activationId: string,
  sources: readonly RemoteSource[],
  observations: Awaited<ReturnType<typeof observeRemoteWork>>,
  time: string,
) {
  return Effect.gen(function* () {
    let changed = false;
    for (const s of sources) {
      const r = s.remote;
      const inserted =
        yield* sql`INSERT INTO coordinator_remote_work(activation_id,parent_thread_id,task_id,environment_id,thread_id,label,status,source_item_id,source_execution_id,source_fingerprint) VALUES(${activationId},${s.parentThreadId},${r.taskId},${r.environmentId},${r.threadId},${r.label},${r.status},${s.itemId},${s.parentRunId},${s.fingerprint}) ON CONFLICT DO NOTHING RETURNING id`;
      changed ||= inserted.length > 0;
      if (r.taskId !== null && r.threadId !== null)
        yield* sql`UPDATE coordinator_remote_work SET resolved=1 WHERE activation_id=${activationId} AND parent_thread_id=${s.parentThreadId} AND source_item_id=${s.itemId} AND source_execution_id=${s.parentRunId} AND environment_id=${r.environmentId} AND resolved=0 AND task_id IS NULL AND thread_id IS NULL`;
    }
    for (const o of observations)
      yield* sql`UPDATE coordinator_remote_work SET available=${o.available ? 1 : 0},pending_request_count=CASE WHEN ${o.pendingRequestCount ?? 0}>0 THEN ${o.pendingRequestCount} ELSE pending_request_count END,observed_at=${time} WHERE activation_id=${activationId} AND environment_id=${o.environmentId} AND thread_id=${o.threadId}`;
    return changed;
  });
}

/** Retain safety evidence before independent execution/lineage reads can fail. */
export function retainRemoteActivity(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  activity: DelegationActivity,
) {
  return Effect.gen(function* () {
    if (!activity.remoteTasks?.length) return false;
    const [activation] = yield* sql<{
      id: string;
    }>`SELECT id FROM run_activations WHERE run_id=${runId} AND block_id=${blockId} ORDER BY rowid DESC LIMIT 1`;
    if (!activation) return false;
    return yield* retainRemoteWork(
      sql,
      activation.id,
      activity.remoteTasks.map((source) => ({ ...source, parentThreadId: activity.threadId })),
      [],
      yield* now,
    );
  });
}

import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { newId } from "./ids.ts";

export interface LocalObservation {
  threadId: string;
  parentThreadId: string | null;
  selections?: readonly {
    runId: string;
    providerInstanceId: string | null;
    model: string | null;
  }[];
  ordinals?: readonly { runId: string; ordinal?: number }[];
  executionIds: readonly (string | null | undefined)[];
}
export type RetainLocal = (observation: LocalObservation) => Promise<void>;

/** Caller must verify local scope and lineage first. These are obligations, not task ownership. */
export function localRetention(
  database: RunnerDatabase,
  run: RunRow,
  blockId: string,
  onChange?: () => void,
): RetainLocal {
  return (observation) =>
    Effect.runPromise(
      database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return false;
          const [parent] = yield* sql<{
            id: string;
          }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${observation.parentThreadId}`;
          const bindings =
            yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,parent_binding_id) VALUES(${yield* newId},${run.id},${blockId},${run.environment_id},${observation.threadId},'descendant',${parent?.id ?? null}) ON CONFLICT DO NOTHING RETURNING id`;
          let changed = bindings.length > 0;
          for (const id of observation.executionIds) {
            if (!id) continue;
            const rows =
              yield* sql`INSERT INTO coordinator_native_obligations(run_id,block_id,thread_id,execution_id) VALUES(${run.id},${blockId},${observation.threadId},${id}) ON CONFLICT DO NOTHING RETURNING execution_id`;
            changed ||= rows.length > 0;
          }
          for (const selection of observation.selections ?? []) {
            if (selection.providerInstanceId === null || selection.model === null) continue;
            const rows =
              yield* sql`INSERT INTO coordinator_local_executions(run_id,thread_id,execution_id,parent_thread_id,provider_instance_id,model) VALUES(${run.id},${observation.threadId},${selection.runId},${observation.parentThreadId},${selection.providerInstanceId},${selection.model}) ON CONFLICT(run_id,thread_id,execution_id) DO UPDATE SET provider_instance_id=excluded.provider_instance_id,model=excluded.model WHERE coordinator_local_executions.provider_instance_id IS NULL AND coordinator_local_executions.model IS NULL AND coordinator_local_executions.parent_thread_id IS excluded.parent_thread_id RETURNING execution_id`;
            changed ||= rows.length > 0;
          }
          for (const execution of observation.ordinals ?? []) {
            if (execution.ordinal === undefined) continue;
            const rows =
              yield* sql`INSERT INTO coordinator_local_executions(run_id,thread_id,execution_id,parent_thread_id,ordinal) VALUES(${run.id},${observation.threadId},${execution.runId},${observation.parentThreadId},${execution.ordinal}) ON CONFLICT(run_id,thread_id,execution_id) DO UPDATE SET ordinal=excluded.ordinal WHERE coordinator_local_executions.ordinal IS NULL AND coordinator_local_executions.parent_thread_id IS excluded.parent_thread_id RETURNING execution_id`;
            changed ||= rows.length > 0;
          }
          if (changed) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          return changed;
        }),
      ),
    ).then((changed) => {
      if (changed) onChange?.();
    });
}

/** The final fresh closure read also retains obligations before queue/native reads. */
export function localClosureRetention(database: RunnerDatabase, run: RunRow) {
  return async (
    block: { blockId: string; threadId: string },
    execution: import("./adapters/t3.ts").ExecutionObservation,
  ) => {
    const [binding] = await Effect.runPromise(
      database.transaction(
        (sql) =>
          sql<{
            parent_thread_id: string | null;
          }>`SELECT p.thread_id AS parent_thread_id FROM run_thread_bindings b LEFT JOIN run_thread_bindings p ON p.id=b.parent_binding_id WHERE b.run_id=${run.id} AND b.block_id=${block.blockId} AND b.thread_id=${block.threadId}`,
      ),
    );
    if (!binding) throw Error("Closure member binding is missing.");
    await localRetention(
      database,
      run,
      block.blockId,
    )({
      threadId: block.threadId,
      parentThreadId: binding.parent_thread_id,
      executionIds: [
        execution.activeRunId,
        execution.latestRunId,
        ...execution.recentRuns.map((e) => e.runId),
      ],
      ordinals: execution.recentRuns,
    });
  };
}

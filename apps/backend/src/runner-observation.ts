import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunStore } from "./runner/run-store/run-store.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import { recoverOperation } from "./runner-effects.ts";
import { bindRunWorkspace } from "./run-workspace-binding.ts";
import { readWorkerThread } from "./worker-thread.ts";

/** Observes each Block's worker thread and derives its execution failure, missing report and
 * native-request attention from the shared thread-finished rule. */
export function openRunnerObservation(store: RunStore, t3: T3Adapter) {
  function observe(runRow: RunRow, block: BlockRow, contextId: string | null) {
    return recoverOperation(
      Effect.gen(function* () {
        if (contextId !== runRow.context_id) throw Error("Authorization context changed.");
        const before = yield* store.readRun(runRow.id);
        const bound = !!before && (yield* bindRunWorkspace(store, t3, before));
        const run = bound ? yield* store.readRun(runRow.id) : before;
        const [current] = yield* store.database.transaction(
          (sql) =>
            sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runRow.id} AND block_id=${block.block_id}`,
        );
        if (!run || !current?.thread_id) return;
        const worker = yield* Effect.tryPromise(() =>
          readWorkerThread(t3, run, current.thread_id!),
        );
        yield* store.recordWorkerObservation(run, current, worker);
      }),
      () => store.markObservationUnavailable(runRow, block.block_id),
    );
  }
  return { observe };
}

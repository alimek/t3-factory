import { observeCoordinator } from "./runner-coordinator-observation.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";

/** Observes a Block's worker frontier from its current saved row. */
export function openRunnerObservation(database: RunnerDatabase, t3: T3Adapter) {
  function observe(runRow: RunRow, block: BlockRow, contextId: string | null) {
    return Effect.gen(function* () {
      const [current] = yield* database.transaction(
        (sql) =>
          sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runRow.id} AND block_id=${block.block_id}`,
      );
      if (!current) return;
      yield* observeCoordinator(database, t3, runRow, current, contextId);
    });
  }
  return { observe };
}

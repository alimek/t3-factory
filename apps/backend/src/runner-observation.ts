import { observeCoordinator } from "./runner-coordinator-observation.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { BlockRow, RunnerOptions, RunRow } from "./runner-types.ts";

/** Observes a Block's worker frontier and keeps its report binding on the exact current execution. */
export function openRunnerObservation(
  database: RunnerDatabase,
  t3: T3Adapter,
  bindings: RunnerOptions["bindings"],
) {
  const { serial, row } = database;
  function bind(runRow: RunRow, block: BlockRow) {
    if (block.thread_id && block.execution_id)
      bindings.bind({
        environmentId: runRow.environment_id,
        workspaceRoot: runRow.workspace_root,
        threadId: block.thread_id,
        runId: block.execution_id,
        projectId: runRow.t3_project_id,
        endpoint: runRow.endpoint,
        contextId: runRow.context_id,
        factoryRunId: runRow.id,
        blockId: block.block_id,
      });
  }
  /** Reading inside the mutation lane prevents a stale caller from reverting report correlation. */
  function bindCurrent(runRow: RunRow, blockId: string) {
    return serial(runRow.id, () =>
      database.transaction((sql) =>
        Effect.gen(function* () {
          const [current] =
            yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runRow.id} AND block_id=${blockId}`;
          if (current && !(yield* row(runRow.id))?.closed_at) bind(runRow, current);
          return current;
        }),
      ),
    );
  }
  function observe(runRow: RunRow, block: BlockRow, contextId: string | null) {
    return Effect.gen(function* () {
      const current = yield* bindCurrent(runRow, block.block_id);
      if (!current) return;
      yield* observeCoordinator(database, t3, runRow, current, contextId);
      // Restore/update trusted correlation only after the exact execution has committed.
      yield* bindCurrent(runRow, block.block_id);
    });
  }
  return { observe };
}

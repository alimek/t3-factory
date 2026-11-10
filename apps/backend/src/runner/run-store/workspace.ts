import * as Effect from "effect/Effect";
import type { RunRow } from "../runner-types.ts";
import { runTarget } from "../runner-utils.ts";
import type { RunWorkspace } from "../run-workspace.ts";
import { now } from "../../time.ts";
import { createEntryLaunches } from "./activations.ts";
import type { RunnerDatabase } from "./database.ts";
import { advanceGeneration } from "./steps.ts";

/** The worktree T3 showed on the creator's worker thread. */
type ShownWorktree = { readonly worktreePath: string; readonly branch: string };

export function openRunWorkspace(database: RunnerDatabase) {
  /** Binds `run`'s preparing worktree (`workspace`) and, in the same transaction, records one launch per
   * other Flow-input target on it. Guards: owner, not Archived, `run`'s authorization context is
   * live; the workspace is still preparing. Advances the generation when bound. Answers whether this
   * call bound it. */
  function bindRunWorkspace(
    run: RunRow,
    workspace: Extract<RunWorkspace, { readonly mode: "worktree" }>,
    { worktreePath, branch }: ShownWorktree,
  ) {
    return database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, run))) return false;
        const time = yield* now;
        const bound =
          yield* sql`UPDATE run_workspaces SET state='bound',worktree_path=${worktreePath},branch=${branch},bound_at=${time} WHERE run_id=${run.id} AND state='preparing' RETURNING run_id`;
        if (!bound.length) return false;
        yield* createEntryLaunches(
          sql,
          {
            runId: run.id,
            number: run.number,
            definitions: run.definitions,
            workspace: { ...workspace, state: "bound", worktreePath, branch },
            project: runTarget(run),
            contextId: run.context_id,
            // Reservation records the retry scope T3 offers when each launch is sent.
            retryScope: null,
            time,
          },
          run.definitions.flow.graph.flowInput.targetBlockIds.filter(
            (blockId) => blockId !== workspace.creatorBlockId,
          ),
        );
        yield* advanceGeneration(sql, run.id);
        return true;
      }),
    );
  }
  return { bindRunWorkspace };
}

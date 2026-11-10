import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import { createEntryLaunches, type RunnerDatabase } from "./runner/run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";

/**
 * Binds a worktree Run's worktree once its creator's thread shows both a path and a branch, and in
 * the same transaction records one launch per other Flow-input target on that worktree. Later
 * Agent Blocks launch their workers there on their first arrival. The path is not readiness: T3
 * queues each launched worker's own setup behind its workspace preparation.
 * Returns whether this call bound the worktree.
 */
export function bindRunWorkspace(database: RunnerDatabase, t3: T3Adapter, run: RunRow) {
  return Effect.gen(function* () {
    const { workspace } = run;
    if (workspace.mode !== "worktree" || workspace.state !== "preparing") return false;
    const [creator] = yield* database.transaction(
      (sql) =>
        sql<{
          thread_id: string | null;
        }>`SELECT thread_id FROM run_blocks WHERE run_id=${run.id} AND block_id=${workspace.creatorBlockId}`,
    );
    const threadId = creator?.thread_id;
    if (!threadId) return false;
    const thread = yield* Effect.tryPromise(() => t3.readExecution(runTarget(run), threadId));
    const worktreePath = thread.workspaceRoot;
    const branch = thread.repository?.branch;
    if (
      thread.threadId !== threadId ||
      thread.projectId !== run.t3_project_id ||
      !worktreePath ||
      !branch
    )
      return false;
    return yield* database.mutate(run.id, (sql) =>
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
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        return true;
      }),
    );
  });
}

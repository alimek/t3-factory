import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import type { RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";

/**
 * Binds a worktree Run's worktree once its creator's thread shows both a path and a branch, and in
 * the same transaction records one launch per other Flow-input target on that worktree. Later
 * Agent Blocks launch their workers there on their first arrival. The path is not readiness: T3
 * queues each launched worker's own setup behind its workspace preparation.
 * Returns whether this call bound the worktree.
 */
export function bindRunWorkspace(store: RunStore, t3: T3Adapter, run: RunRow) {
  return Effect.gen(function* () {
    const { workspace } = run;
    if (workspace.mode !== "worktree" || workspace.state !== "preparing") return false;
    const creator = yield* store.readBlock(run.id, workspace.creatorBlockId);
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
    return yield* store.bindRunWorkspace(run, workspace, { worktreePath, branch });
  });
}

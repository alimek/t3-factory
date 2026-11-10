import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunWorkspace } from "../run-workspace.ts";

export const readRunWorkspace = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  runId: string,
) {
  const [row] = yield* sql<{
    base_ref: string;
    planned_branch: string;
    creator_block_id: string;
    state: "preparing" | "bound" | "failed";
    worktree_path: string | null;
    branch: string | null;
  }>`SELECT base_ref,planned_branch,creator_block_id,state,worktree_path,branch FROM run_workspaces WHERE run_id=${runId}`;
  if (!row) return { mode: "checkout" } satisfies RunWorkspace;
  const plan = {
    mode: "worktree" as const,
    baseRef: row.base_ref,
    plannedBranch: row.planned_branch,
    creatorBlockId: row.creator_block_id,
  };
  const workspace: RunWorkspace =
    row.state === "bound"
      ? // The table CHECK gives every bound row its path and branch.
        { ...plan, state: "bound", worktreePath: row.worktree_path!, branch: row.branch! }
      : { ...plan, state: row.state };
  return workspace;
});

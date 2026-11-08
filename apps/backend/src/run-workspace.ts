import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { LaunchCandidate, LaunchPayload } from "./adapters/t3.ts";

/**
 * The workspace a Run's workers share. A checkout Run works in its project root. A worktree Run's
 * creator Block launches the worker that creates the worktree; Factory binds the path and branch
 * T3 then reports, and every later worker of the Run joins that worktree.
 */
export type RunWorkspace =
  | { readonly mode: "checkout" }
  | {
      readonly mode: "worktree";
      readonly baseRef: string;
      readonly plannedBranch: string;
      readonly creatorBlockId: string;
      readonly state: "preparing" | "bound" | "failed";
      /** Null until bound. */
      readonly worktreePath: string | null;
      readonly branch: string | null;
    };
/** Null is T3's project checkout. Any other path must be that checkout. */
const checkoutWorkspace = (workspaceRoot: string | null, checkout: string) =>
  workspaceRoot === null || workspaceRoot === checkout;
type WorkspaceRun = { readonly workspace: RunWorkspace; readonly workspace_root: string };
type WorkspaceStrategy = LaunchPayload["workspaceStrategy"];

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
  const workspace: RunWorkspace = row
    ? {
        mode: "worktree",
        baseRef: row.base_ref,
        plannedBranch: row.planned_branch,
        creatorBlockId: row.creator_block_id,
        state: row.state,
        worktreePath: row.worktree_path,
        branch: row.branch,
      }
    : { mode: "checkout" };
  return workspace;
});

/** Factory names the branch so T3 does not rename it later: unique per Run number and Run id. */
export const worktreeBranch = (number: number, runId: string) =>
  `factory/run-${number}-${runId.slice(0, 8)}`;

/** The strategy a worker of this Block launches with now; undefined while it must wait. */
export function launchStrategy(
  workspace: RunWorkspace,
  blockId: string,
): WorkspaceStrategy | undefined {
  if (workspace.mode === "checkout") return { type: "root" };
  if (workspace.state === "bound")
    return {
      type: "existing_worktree",
      worktreePath: workspace.worktreePath!,
      branch: workspace.branch!,
    };
  if (workspace.state === "preparing" && blockId === workspace.creatorBlockId)
    return { type: "worktree", baseRef: workspace.baseRef, branch: workspace.plannedBranch };
  return undefined;
}

export const sameStrategy = (actual: WorkspaceStrategy, expected: WorkspaceStrategy | undefined) =>
  !!expected && JSON.stringify(actual) === JSON.stringify(expected);

/** A checkout Run's threads show T3's checkout (null) or the project root; a worktree Run's
 * threads show its bound worktree, and nothing but the not-yet-reported null before binding. */
export function inRunWorkspace(run: WorkspaceRun, workspaceRoot: string | null) {
  if (run.workspace.mode === "checkout")
    return checkoutWorkspace(workspaceRoot, run.workspace_root);
  return workspaceRoot === run.workspace.worktreePath;
}

/** A recovered launch shows its strategy's workspace. A null branch never matches a worktree. */
export function launchedInWorkspace(
  strategy: WorkspaceStrategy,
  candidate: Pick<LaunchCandidate, "workspaceRoot" | "branch">,
  projectRoot: string,
) {
  switch (strategy.type) {
    case "root":
      return checkoutWorkspace(candidate.workspaceRoot, projectRoot);
    case "worktree":
      return candidate.workspaceRoot !== null && candidate.branch === strategy.branch;
    case "existing_worktree":
      return (
        candidate.workspaceRoot === strategy.worktreePath && candidate.branch === strategy.branch
      );
  }
}

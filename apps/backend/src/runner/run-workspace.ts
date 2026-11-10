import type { ExecutionObservation, LaunchCandidate, LaunchPayload } from "../adapters/t3.ts";

/**
 * The workspace a Run's workers share. A checkout Run works in its project root. A worktree Run's
 * creator Block launches the worker that creates the worktree; Factory binds the path and branch
 * T3 then reports, and every later worker of the Run joins that worktree.
 */
export type RunWorkspace =
  | { readonly mode: "checkout" }
  | (WorktreePlan &
      (
        | { readonly state: "preparing" | "failed" }
        | { readonly state: "bound"; readonly worktreePath: string; readonly branch: string }
      ));
type WorktreePlan = {
  readonly mode: "worktree";
  readonly baseRef: string;
  readonly plannedBranch: string;
  readonly creatorBlockId: string;
};
/** Null is T3's project checkout. Any other path must be that checkout. */
const checkoutWorkspace = (workspaceRoot: string | null, checkout: string) =>
  workspaceRoot === null || workspaceRoot === checkout;
type WorkspaceRun = { readonly workspace: RunWorkspace; readonly workspace_root: string };
type WorkspaceStrategy = LaunchPayload["workspaceStrategy"];

export const WORKTREE_REJECTED = "T3 rejected the worker that creates the Run worktree.";

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
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
    };
  if (workspace.state === "preparing" && blockId === workspace.creatorBlockId)
    return { type: "worktree", baseRef: workspace.baseRef, branch: workspace.plannedBranch };
  return undefined;
}

/** The same fields with equal values, in any order. */
export function sameStrategy(actual: WorkspaceStrategy, expected: WorkspaceStrategy | undefined) {
  if (!expected) return false;
  const stored: Readonly<Record<string, unknown>> = actual;
  const wanted: Readonly<Record<string, unknown>> = expected;
  const fields = Object.keys(wanted);
  return (
    Object.keys(stored).length === fields.length &&
    fields.every((field) => stored[field] === wanted[field])
  );
}

/**
 * A checkout Run's threads show T3's checkout (null) or the project root; a bound worktree Run's
 * threads show its worktree. Before binding only the creator has a thread, and T3 may show its
 * path before its branch, so any path with no branch or the planned branch is still its own.
 */
export function inRunWorkspace(
  run: WorkspaceRun,
  thread: Pick<ExecutionObservation, "workspaceRoot" | "repository">,
) {
  const { workspace } = run;
  if (workspace.mode === "checkout")
    return checkoutWorkspace(thread.workspaceRoot, run.workspace_root);
  if (workspace.state === "bound") return thread.workspaceRoot === workspace.worktreePath;
  const branch = thread.repository?.branch ?? null;
  return branch === null || branch === workspace.plannedBranch;
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

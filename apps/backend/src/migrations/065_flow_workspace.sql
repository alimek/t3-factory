-- Flow revisions gain the workspace their Runs share. Every existing revision, including those
-- retained Runs captured, keeps the project checkout it always used; nothing is appended.
-- A worktree revision without a base ref starts from the Project repository's default branch.
ALTER TABLE flow_revisions ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'checkout'
  CHECK (workspace_mode IN ('checkout', 'worktree'))
-- statement-breakpoint
ALTER TABLE flow_revisions ADD COLUMN workspace_base_ref TEXT
  CHECK (workspace_base_ref IS NULL
    OR (workspace_mode = 'worktree' AND length(workspace_base_ref) BETWEEN 1 AND 255))

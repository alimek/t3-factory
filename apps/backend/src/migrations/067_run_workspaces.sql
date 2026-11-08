-- The shared worktree of a worktree Run, written with its accepted Start. Checkout Runs, including
-- every retained Run, have no row: they work in the project root their runs row already names.
-- The creator Block's worker creates the worktree; Factory binds the path and branch T3 reports.
CREATE TABLE run_workspaces (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  base_ref TEXT NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  planned_branch TEXT NOT NULL CHECK (length(planned_branch) > 0),
  creator_block_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing', 'bound', 'failed')),
  worktree_path TEXT,
  branch TEXT,
  bound_at TEXT,
  FOREIGN KEY (run_id, creator_block_id) REFERENCES run_blocks(run_id, block_id),
  CHECK ((state = 'bound') = (worktree_path IS NOT NULL AND branch IS NOT NULL AND bound_at IS NOT NULL))
)

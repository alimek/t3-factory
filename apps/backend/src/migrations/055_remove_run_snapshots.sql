-- Runs read their definitions from the revisions 054 attached, so the snapshot copy is removed
-- and every Run and Agent activation must reference its revision. The tables are rebuilt to
-- make those references NOT NULL. Rows are restored after the old table is dropped: re-inserting
-- parent rows is what clears the deferred foreign key violations the drop records for children.
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
DROP TABLE run_snapshots
-- statement-breakpoint
CREATE TEMP TABLE runs_saved AS SELECT * FROM runs
-- statement-breakpoint
DROP TABLE runs
-- statement-breakpoint
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  input TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES t3_authorization_contexts(id),
  workspace_root TEXT NOT NULL,
  gate_open INTEGER NOT NULL DEFAULT 1 CHECK(gate_open IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  closed_at TEXT,
  outcome TEXT,
  stop_requested_at TEXT,
  title TEXT NOT NULL DEFAULT '',
  number INTEGER,
  created_at TEXT NOT NULL DEFAULT '',
  creation_key TEXT NOT NULL DEFAULT '',
  flow_revision_id TEXT NOT NULL REFERENCES flow_revisions(id)
)
-- statement-breakpoint
INSERT INTO runs (
  id, task_id, request_id, request_fingerprint, input, context_id, workspace_root, gate_open,
  generation, started_at, closed_at, outcome, stop_requested_at, title, number, created_at,
  creation_key, flow_revision_id
)
SELECT
  id, task_id, request_id, request_fingerprint, input, context_id, workspace_root, gate_open,
  generation, started_at, closed_at, outcome, stop_requested_at, title, number, created_at,
  creation_key, flow_revision_id
FROM runs_saved
-- statement-breakpoint
DROP TABLE runs_saved
-- statement-breakpoint
CREATE UNIQUE INDEX one_open_run_per_task ON runs(task_id) WHERE closed_at IS NULL
-- statement-breakpoint
CREATE UNIQUE INDEX runs_number_unique ON runs(number) WHERE number IS NOT NULL
-- statement-breakpoint
CREATE TRIGGER immutable_run_flow_revision BEFORE UPDATE OF flow_revision_id ON runs
BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END
-- statement-breakpoint
CREATE TEMP TABLE run_activations_saved AS SELECT * FROM run_activations
-- statement-breakpoint
DROP TABLE run_activations
-- statement-breakpoint
CREATE TABLE run_activations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'delegating' CHECK(phase IN ('delegating','waiting-worker','assessing','reported','finished')),
  coverage TEXT NOT NULL DEFAULT 'unverified' CHECK(coverage IN ('unverified','local-bounded')),
  created_at TEXT NOT NULL,
  evidence_json TEXT,
  problem TEXT,
  agent_revision_id TEXT NOT NULL REFERENCES agent_revisions(id),
  UNIQUE(run_id,cause),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
INSERT INTO run_activations (
  id, run_id, block_id, cause, phase, coverage, created_at, evidence_json, problem,
  agent_revision_id
)
SELECT
  id, run_id, block_id, cause, phase, coverage, created_at, evidence_json, problem,
  agent_revision_id
FROM run_activations_saved
-- statement-breakpoint
DROP TABLE run_activations_saved
-- statement-breakpoint
CREATE TRIGGER immutable_activation_agent_revision BEFORE UPDATE OF agent_revision_id ON run_activations
BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF

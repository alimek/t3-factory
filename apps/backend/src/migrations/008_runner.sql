CREATE TABLE runner_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
)
-- statement-breakpoint
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
)
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
  outcome TEXT
)
-- statement-breakpoint
CREATE UNIQUE INDEX one_open_run_per_task ON runs(task_id) WHERE closed_at IS NULL
-- statement-breakpoint
CREATE TABLE run_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  snapshot_json TEXT NOT NULL
)
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_update BEFORE UPDATE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_delete BEFORE DELETE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END
-- statement-breakpoint
CREATE TABLE run_blocks (
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'not-started',
  thread_id TEXT,
  execution_id TEXT,
  link TEXT,
  engine_status TEXT,
  report_status TEXT,
  pending_request_count INTEGER,
  observed_at TEXT,
  freshness TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY(run_id,block_id),
  UNIQUE(run_id,thread_id)
)
-- statement-breakpoint
CREATE TABLE run_executions (
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  engine_status TEXT,
  report_status TEXT,
  observed_at TEXT,
  PRIMARY KEY(run_id,block_id,execution_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
CREATE TABLE operation_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cause TEXT NOT NULL,
  target_json TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  payload_json TEXT,
  fingerprint TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES t3_authorization_contexts(id),
  retry_scope TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','uncertain','acknowledged','cancelled')),
  reserved_by TEXT,
  reserved_at TEXT,
  result_json TEXT,
  problem TEXT,
  reconciled_at TEXT,
  UNIQUE(run_id,cause),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
CREATE UNIQUE INDEX one_reservation_per_run ON operation_intents(run_id) WHERE state='reserved'
-- statement-breakpoint
CREATE TABLE run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(run_id,source_key)
)

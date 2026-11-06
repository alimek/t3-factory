-- Run conversations have Run ownership; they are never assigned to a synthetic Flow block.
CREATE TABLE run_coordinators (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  selection_json TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  payload_json TEXT,
  fingerprint TEXT NOT NULL,
  retry_scope TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','uncertain','acknowledged','cancelled')),
  reserved_by TEXT,
  reserved_at TEXT,
  thread_id TEXT UNIQUE,
  execution_id TEXT,
  link TEXT,
  engine_status TEXT,
  problem TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

-- Manual Settle stops executing workers once the user confirms it. Accepting a confirmed
-- settlement closes the Run's handoff gate and records it here; the Run settles once fresh T3
-- reads confirm every bound worker finished. The confirmation and every retry are attempts. Only
-- the backend owner that accepted an attempt requests Stop, at most once per worker in it: in
-- that attempt's first pass, or when a worker joins the attempt later, recording the request
-- before sending it. Runs settled earlier keep their open
-- gate, owed work and reactivation by reports; this migration stops and cancels nothing.
CREATE TABLE run_settlements (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  requested_at TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  attempt_owner TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  stop_pass_at TEXT
)
-- statement-breakpoint
CREATE TABLE run_settlement_workers (
  run_id TEXT NOT NULL REFERENCES run_settlements(run_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  thread_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('stopping', 'finished', 'unresolved')),
  problem TEXT,
  stop_key TEXT UNIQUE,
  stop_requested_at TEXT,
  stop_outcome TEXT CHECK (stop_outcome IN ('acknowledged', 'failed', 'unsupported')),
  stop_problem TEXT,
  PRIMARY KEY (run_id, attempt, thread_id),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
)

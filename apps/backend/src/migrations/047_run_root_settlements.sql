-- Presentation obligations belong to the Run, never a fabricated Block execution.
-- Created atomically with new closure only; historical closed Runs are not backfilled.
CREATE TABLE run_root_settlements (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  retired_at TEXT,
  outcome TEXT CHECK(outcome IN ('acknowledged','uncertain'))
);

-- Obligations are created only for successful stages observed while their Run is open.
-- Claim before I/O: without a server replay key an attempted request is never repeated.
CREATE TABLE thread_settlements (
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  retired_at TEXT,
  outcome TEXT CHECK(outcome IN ('acknowledged','uncertain')),
  PRIMARY KEY(run_id,block_id,execution_id),
  FOREIGN KEY(run_id,block_id,execution_id) REFERENCES run_executions(run_id,block_id,execution_id)
)

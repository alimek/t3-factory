CREATE TABLE runtime_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  report_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting','finished')),
  exit_id TEXT,
  recipients_json TEXT NOT NULL,
  pending_message TEXT,
  acknowledgement_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE(run_id,block_id,execution_id,report_key),
  FOREIGN KEY(run_id,block_id,execution_id) REFERENCES run_executions(run_id,block_id,execution_id)
)
-- statement-breakpoint
CREATE TABLE run_attention (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  native_request_id TEXT,
  occurrence_id TEXT,
  appeared_at TEXT NOT NULL,
  settled_at TEXT,
  settlement_reason TEXT,
  UNIQUE(run_id,source_key),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
ALTER TABLE run_events ADD COLUMN execution_id TEXT
-- statement-breakpoint
ALTER TABLE run_events ADD COLUMN cause_id TEXT
-- statement-breakpoint
ALTER TABLE run_events ADD COLUMN source_at TEXT
-- statement-breakpoint
ALTER TABLE run_executions ADD COLUMN ordinal INTEGER
-- statement-breakpoint
ALTER TABLE run_executions ADD COLUMN source_at TEXT
-- statement-breakpoint
ALTER TABLE run_executions ADD COLUMN problem TEXT
-- statement-breakpoint
ALTER TABLE run_executions ADD COLUMN native_request_count INTEGER
-- statement-breakpoint
ALTER TABLE run_blocks ADD COLUMN problem TEXT
-- statement-breakpoint
ALTER TABLE run_events ADD COLUMN engine_status TEXT

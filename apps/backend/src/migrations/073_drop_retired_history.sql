-- The owner accepted discarding retired history no source reads (issue #161): Conversation wait
-- records, Run coordinator obligation evidence and prepared worker threads. working_reports is
-- rebuilt first because its retired_wait_id column references coordinator_waits.
CREATE TABLE working_reports_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  execution_id TEXT,
  fingerprint TEXT NOT NULL,
  message TEXT NOT NULL,
  acknowledgement_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  replaced_at TEXT,
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
INSERT INTO working_reports_next (
  id, run_id, block_id, activation_id, execution_id, fingerprint, message, acknowledgement_json,
  accepted_at, replaced_at
)
SELECT
  id, run_id, block_id, activation_id, execution_id, fingerprint, message, acknowledgement_json,
  accepted_at, replaced_at
FROM working_reports ORDER BY rowid
-- statement-breakpoint
DROP TABLE working_reports
-- statement-breakpoint
ALTER TABLE working_reports_next RENAME TO working_reports
-- statement-breakpoint
CREATE UNIQUE INDEX one_current_working_report ON working_reports(activation_id) WHERE replaced_at IS NULL
-- statement-breakpoint
DROP TABLE coordinator_waits
-- statement-breakpoint
DROP TABLE run_coordinator_obligations
-- statement-breakpoint
DROP TABLE run_prepared_workers

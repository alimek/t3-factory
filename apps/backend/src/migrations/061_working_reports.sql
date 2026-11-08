-- A non-final working report says a Block's worker is still on its task, for example while CI
-- or review runs. It is the current report of its activation until a later working, waiting or
-- finished report replaces it. Every working report is kept as history.
-- Request report now targets an idle Block without a finished result, which need not have a
-- missing-report Problem: a recovery is identified by its send and links the Problem it settles
-- only when one was pending. Existing recoveries keep their Problem link; no rows are removed.
CREATE TABLE working_reports (
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
CREATE UNIQUE INDEX one_current_working_report ON working_reports(activation_id) WHERE replaced_at IS NULL
-- statement-breakpoint
CREATE TABLE report_recoveries_next (
  intent_id TEXT PRIMARY KEY REFERENCES operation_intents(id),
  attention_id TEXT UNIQUE REFERENCES run_attention(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  settled_at TEXT,
  thread_scope TEXT,
  FOREIGN KEY(run_id,thread_scope,source_execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
)
-- statement-breakpoint
INSERT INTO report_recoveries_next (
  intent_id, attention_id, run_id, block_id, source_execution_id, requested_at, settled_at,
  thread_scope
)
SELECT
  intent_id, attention_id, run_id, block_id, source_execution_id, requested_at, settled_at,
  thread_scope
FROM report_recoveries ORDER BY rowid
-- statement-breakpoint
DROP TABLE report_recoveries
-- statement-breakpoint
ALTER TABLE report_recoveries_next RENAME TO report_recoveries

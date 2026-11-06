CREATE TABLE report_recoveries (
  attention_id TEXT PRIMARY KEY REFERENCES run_attention(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  requested_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY(run_id,block_id,source_execution_id) REFERENCES run_executions(run_id,block_id,execution_id)
)

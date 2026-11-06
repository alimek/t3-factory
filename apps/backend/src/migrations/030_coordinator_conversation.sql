-- Waiting is non-final and separate from immutable activation results.
CREATE TABLE coordinator_waits (
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  parent_execution_id TEXT NOT NULL,
  report_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  acknowledgement_json TEXT NOT NULL,
  target_binding_id TEXT NOT NULL REFERENCES run_thread_bindings(id),
  target_execution_id TEXT NOT NULL,
  attention_id TEXT NOT NULL REFERENCES run_attention(id),
  UNIQUE(activation_id,parent_execution_id,report_key)
);
-- statement-breakpoint
CREATE TABLE coordinator_task_results (
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  task_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(activation_id,task_id)
);

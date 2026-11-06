CREATE TABLE coordinator_recoveries (
  attention_id TEXT PRIMARY KEY REFERENCES report_recoveries(attention_id),
  activation_id TEXT NOT NULL UNIQUE REFERENCES run_activations(id),
  parent_binding_id TEXT NOT NULL REFERENCES run_thread_bindings(id),
  worker_binding_id TEXT NOT NULL REFERENCES run_thread_bindings(id),
  worker_execution_id TEXT NOT NULL
);

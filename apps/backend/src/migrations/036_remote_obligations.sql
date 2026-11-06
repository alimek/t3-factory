-- Remote safety references are not local execution/report bindings. Existing Runs and
-- persisted dispatch payloads retain their original instruction and execution contracts.
CREATE TABLE coordinator_remote_work (
  id INTEGER PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  parent_thread_id TEXT NOT NULL,
  task_id TEXT,
  environment_id TEXT NOT NULL,
  thread_id TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 0,
  pending_request_count INTEGER,
  observed_at TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  CHECK((task_id IS NULL) = (thread_id IS NULL))
);
-- statement-breakpoint
CREATE UNIQUE INDEX remote_work_source ON coordinator_remote_work(
  activation_id,parent_thread_id,source_item_id,source_execution_id,environment_id,
  COALESCE(task_id,''),COALESCE(thread_id,'')
);

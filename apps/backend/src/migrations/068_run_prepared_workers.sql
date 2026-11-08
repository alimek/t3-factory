-- Idle worker threads a worktree Run prepares for its later Agent Blocks. A prepared worker is not
-- a visit: run_blocks.thread_id stays null until the first activation's send is acknowledged, so
-- observation, reports, settlement and archive never see an idle thread. Retained Runs have none.
CREATE TABLE run_prepared_workers (
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  link TEXT,
  intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  prepared_at TEXT NOT NULL,
  PRIMARY KEY (run_id, block_id),
  UNIQUE (run_id, thread_id),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
)

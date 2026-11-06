CREATE TABLE human_occurrences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','withdrawn','cancelled-on-Stop')),
  pending_context TEXT,
  appeared_at TEXT NOT NULL,
  settled_at TEXT,
  exit_id TEXT,
  answer_fingerprint TEXT,
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
ALTER TABLE operation_intents ADD COLUMN occurrence_id TEXT REFERENCES human_occurrences(id)

-- Continuation blocks: a Flow block kind with a prompt and one fixed output. Every Flow revision
-- keeps its blocks unchanged; only the kind constraint and the prompt column are new.
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TEMP TABLE flow_revision_blocks_saved AS SELECT * FROM flow_revision_blocks
-- statement-breakpoint
DROP TABLE flow_revision_blocks
-- statement-breakpoint
CREATE TABLE flow_revision_blocks (
  flow_revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
  block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'continuation')),
  name TEXT NOT NULL,
  -- Unresolved by design: drafts may name a missing Agent, and history outlives the Agent.
  agent_id TEXT CHECK (kind = 'agent' OR agent_id IS NULL),
  -- The prompt a Continuation sends once per Run; empty only in a draft.
  prompt TEXT CHECK ((kind = 'continuation') = (prompt IS NOT NULL)),
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (flow_revision_id, block_id),
  UNIQUE (flow_revision_id, ordinal)
)
-- statement-breakpoint
INSERT INTO flow_revision_blocks (flow_revision_id, block_id, ordinal, kind, name, agent_id, prompt, x, y)
SELECT flow_revision_id, block_id, ordinal, kind, name, agent_id, NULL, x, y
FROM flow_revision_blocks_saved ORDER BY rowid
-- statement-breakpoint
DROP TABLE flow_revision_blocks_saved
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_block_update BEFORE UPDATE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_block_delete BEFORE DELETE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF
-- statement-breakpoint
-- The worker thread a handoff's message belongs to: an Agent result carries its worker, a Human
-- answer the worker of the delivery it answered, a Continuation the thread its prompt ran on and a
-- pass-through the arrival's own worker. Earlier rows carry none: no captured revision before
-- this migration has a Continuation, the only reader.
ALTER TABLE operation_intents ADD COLUMN binding_id TEXT REFERENCES run_thread_bindings(id)
-- statement-breakpoint
-- One row per message that reached a Continuation. The first is its prompt visit, which sends the
-- prompt and owns the activation the worker reports against; every later one passes through.
CREATE TABLE continuation_visits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'pass-through')),
  source_block_id TEXT,
  binding_id TEXT REFERENCES run_thread_bindings(id),
  activation_id TEXT UNIQUE REFERENCES run_activations(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'sent', 'forwarded', 'cancelled')),
  arrived_at TEXT NOT NULL,
  forwarded_at TEXT,
  CHECK ((kind = 'prompt') = (activation_id IS NOT NULL)),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
)
-- statement-breakpoint
CREATE UNIQUE INDEX one_prompt_per_continuation ON continuation_visits(run_id, block_id) WHERE kind = 'prompt'
-- statement-breakpoint
DROP INDEX run_activity_by_run
-- statement-breakpoint
CREATE INDEX run_activity_by_run ON run_events(run_id, observed_at DESC)
WHERE kind IN ('execution-observed','report-accepted','working-reported','human-answered','attention-appeared','handoff-released','continuation-passed','run-settled','run-activated')

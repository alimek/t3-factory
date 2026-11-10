-- Wait blocks: a Flow block kind with a fixed duration and one fixed output. Every Flow revision
-- keeps its blocks unchanged; only the kind constraint and the duration columns are new.
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
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'continuation', 'wait')),
  name TEXT NOT NULL,
  -- Unresolved by design: drafts may name a missing Agent, and history outlives the Agent.
  agent_id TEXT CHECK (kind = 'agent' OR agent_id IS NULL),
  -- The prompt a Continuation sends once per Run; empty only in a draft.
  prompt TEXT CHECK ((kind = 'continuation') = (prompt IS NOT NULL)),
  -- A Wait's duration as entered; the amount is missing or out of range only in a draft.
  wait_amount INTEGER CHECK (kind = 'wait' OR wait_amount IS NULL),
  wait_unit TEXT CHECK (wait_unit IN ('minutes', 'hours', 'days')),
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (flow_revision_id, block_id),
  UNIQUE (flow_revision_id, ordinal),
  CHECK ((kind = 'wait') = (wait_unit IS NOT NULL))
)
-- statement-breakpoint
INSERT INTO flow_revision_blocks (flow_revision_id, block_id, ordinal, kind, name, agent_id, prompt, wait_amount, wait_unit, x, y)
SELECT flow_revision_id, block_id, ordinal, kind, name, agent_id, prompt, NULL, NULL, x, y
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
-- With binding_id, the origin of a handoff's message: the Block activation whose result produced
-- it, kept unchanged through Waits and pass-throughs. Earlier rows carry none: no captured
-- revision before this migration has a Wait, the only reader.
ALTER TABLE operation_intents ADD COLUMN origin_activation_id TEXT REFERENCES run_activations(id)
-- statement-breakpoint
-- One row per delivery that reached a Wait. Each arrival keeps its message until it is forwarded
-- or cancelled, and its own deadline counted from the incoming handoff's release.
CREATE TABLE wait_arrivals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  source_block_id TEXT,
  -- The Final result version whose message waits; null for a Human answer.
  report_id TEXT REFERENCES runtime_reports(id),
  binding_id TEXT REFERENCES run_thread_bindings(id),
  origin_activation_id TEXT REFERENCES run_activations(id),
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'forwarded', 'cancelled')),
  forward_reason TEXT,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((state = 'pending') = (settled_at IS NULL)),
  CHECK ((state = 'forwarded') = (forward_reason IS NOT NULL)),
  CHECK (state = 'pending' OR message IS NULL),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
)
-- statement-breakpoint
CREATE INDEX pending_wait_arrivals ON wait_arrivals(run_id, deadline_at) WHERE state = 'pending'
-- statement-breakpoint
DROP INDEX run_activity_by_run
-- statement-breakpoint
CREATE INDEX run_activity_by_run ON run_events(run_id, observed_at DESC)
WHERE kind IN ('execution-observed','report-accepted','working-reported','human-answered','attention-appeared','handoff-released','continuation-passed','wait-elapsed','run-settled','run-activated')

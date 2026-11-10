-- Wait blocks: a Flow revision block may be a Wait with an optional fixed duration. Existing
-- revisions keep every block unchanged; no Wait is inferred. The block table is rebuilt under its
-- immutability guard because SQLite cannot widen a CHECK in place.
DROP TRIGGER immutable_flow_revision_block_update
-- statement-breakpoint
DROP TRIGGER immutable_flow_revision_block_delete
-- statement-breakpoint
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TABLE flow_revision_blocks_with_waits (
  flow_revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
  block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'continuation', 'wait')),
  name TEXT NOT NULL,
  -- Unresolved by design: drafts may name a missing Agent, and history outlives the Agent.
  agent_id TEXT CHECK (kind = 'agent' OR agent_id IS NULL),
  -- The prompt a Continuation sends once per Run; empty only in a draft.
  prompt TEXT CHECK ((kind = 'continuation') = (prompt IS NOT NULL)),
  x REAL NOT NULL,
  y REAL NOT NULL,
  -- A Wait's duration; both are null while the draft has none. Readiness owns the range.
  wait_amount INTEGER CHECK (wait_amount IS NULL OR wait_amount >= 0),
  wait_unit TEXT CHECK (wait_unit IS NULL OR wait_unit IN ('minutes', 'hours', 'days')),
  CHECK ((wait_amount IS NULL) = (wait_unit IS NULL)),
  CHECK (kind = 'wait' OR wait_amount IS NULL),
  PRIMARY KEY (flow_revision_id, block_id),
  UNIQUE (flow_revision_id, ordinal)
)
-- statement-breakpoint
INSERT INTO flow_revision_blocks_with_waits (flow_revision_id, block_id, ordinal, kind, name, agent_id, prompt, x, y)
SELECT flow_revision_id, block_id, ordinal, kind, name, agent_id, prompt, x, y FROM flow_revision_blocks ORDER BY rowid
-- statement-breakpoint
DROP TABLE flow_revision_blocks
-- statement-breakpoint
ALTER TABLE flow_revision_blocks_with_waits RENAME TO flow_revision_blocks
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_block_update BEFORE UPDATE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_block_delete BEFORE DELETE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF
-- statement-breakpoint
-- One durable arrival per accepted delivery to a Wait: its retained message and the worker
-- provenance it carries, the absolute deadline counted from the delivery's release, and its
-- outcome. The message is the input its recipients read after forwarding; Archive clears it.
-- `binding_id` is the worker thread a later Continuation continues; `origin_activation_id` the
-- Block activation whose result the message is, known only together with its thread.
CREATE TABLE wait_arrivals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'forwarded', 'cancelled')),
  forwarded_by TEXT CHECK (forwarded_by IN ('timer')),
  message TEXT,
  binding_id TEXT REFERENCES run_thread_bindings(id),
  origin_activation_id TEXT REFERENCES run_activations(id),
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((state = 'forwarded') = (forwarded_by IS NOT NULL)),
  CHECK ((state = 'pending') = (settled_at IS NULL)),
  CHECK (origin_activation_id IS NULL OR binding_id IS NOT NULL),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
)
-- statement-breakpoint
CREATE INDEX wait_arrivals_pending ON wait_arrivals(deadline_at) WHERE state = 'pending'
-- statement-breakpoint
-- A Handoff a Wait arrival's forwarding created.
ALTER TABLE operation_intents ADD COLUMN wait_arrival_id TEXT REFERENCES wait_arrivals(id)
-- statement-breakpoint
-- The Block activation whose result a delivery carries, beside the worker thread in `binding_id`:
-- Agent and Continuation results set both, Waits and pass-throughs forward them unchanged; null
-- when no activation is known.
ALTER TABLE operation_intents ADD COLUMN origin_activation_id TEXT REFERENCES run_activations(id)
-- statement-breakpoint
-- Existing deliveries from a Final result derive their worker from the recorded result: the thread
-- a Continuation's prompt ran on, else its Block's bound worker. A delivery without one keeps none.
UPDATE operation_intents SET binding_id = COALESCE(
  (SELECT v.binding_id FROM continuation_visits v JOIN runtime_reports r ON r.activation_id = v.activation_id
    WHERE r.id = operation_intents.report_id),
  (SELECT t.id FROM runtime_reports r
    JOIN run_blocks b ON b.run_id = r.run_id AND b.block_id = r.block_id
    JOIN run_thread_bindings t ON t.run_id = b.run_id AND t.thread_id = b.thread_id
    WHERE r.id = operation_intents.report_id))
WHERE report_id IS NOT NULL AND binding_id IS NULL
-- statement-breakpoint
UPDATE operation_intents SET
  origin_activation_id = (SELECT r.activation_id FROM runtime_reports r WHERE r.id = operation_intents.report_id)
WHERE report_id IS NOT NULL AND binding_id IS NOT NULL

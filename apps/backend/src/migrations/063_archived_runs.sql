-- Archive replaces Stop. Archiving closes the handoff gate, cancels unsent work and requests
-- interruption of the worker threads without waiting for confirmation, and the Run is final and
-- hidden from navigation with all its data kept. Closed Stopped Runs and Runs still waiting for
-- Stop confirmation become Archived; their closure evidence, interrupt requests, events and
-- reports are kept. Human occurrences cancelled by Stop keep their state as cancelled. The
-- permanent closed and stop columns go: a Run is Active, Settled or Archived.
ALTER TABLE runs ADD COLUMN archived_at TEXT
-- statement-breakpoint
UPDATE runs SET archived_at=COALESCE(closed_at,stop_requested_at),gate_open=0 WHERE outcome='stopped' OR stop_requested_at IS NOT NULL
-- statement-breakpoint
ALTER TABLE runs DROP COLUMN closed_at
-- statement-breakpoint
ALTER TABLE runs DROP COLUMN outcome
-- statement-breakpoint
ALTER TABLE runs DROP COLUMN stop_requested_at
-- statement-breakpoint
DROP TRIGGER settle_run_presentation
-- statement-breakpoint
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TEMP TABLE human_occurrences_saved AS SELECT * FROM human_occurrences
-- statement-breakpoint
DROP TABLE human_occurrences
-- statement-breakpoint
CREATE TABLE human_occurrences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','withdrawn','cancelled')),
  pending_context TEXT,
  appeared_at TEXT NOT NULL,
  settled_at TEXT,
  exit_id TEXT,
  answer_fingerprint TEXT,
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)
-- statement-breakpoint
INSERT INTO human_occurrences (
  id, run_id, block_id, incoming_intent_id, state, pending_context, appeared_at, settled_at,
  exit_id, answer_fingerprint
)
SELECT
  id, run_id, block_id, incoming_intent_id,
  CASE WHEN state='cancelled-on-Stop' THEN 'cancelled' ELSE state END,
  pending_context, appeared_at, settled_at, exit_id, answer_fingerprint
FROM human_occurrences_saved ORDER BY rowid
-- statement-breakpoint
DROP TABLE human_occurrences_saved
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF

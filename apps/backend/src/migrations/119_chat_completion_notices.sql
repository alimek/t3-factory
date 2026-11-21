-- Keep existing delivery identities, order and references, including retired and delivered
-- lifecycle messages. Only the current delivery contract exposes completion notices.
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TEMP TABLE chat_deliveries_saved AS SELECT rowid AS saved_rowid, * FROM chat_deliveries
-- statement-breakpoint
DROP TABLE chat_deliveries
-- statement-breakpoint
CREATE TABLE chat_deliveries (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('receipt', 'status-card', 'attention', 'lifecycle', 'catch-up', 'completion')),
  action_id TEXT REFERENCES chat_actions(id),
  run_id TEXT,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owed', 'sending', 'delivered', 'failed', 'unknown', 'cancelled', 'lost', 'retired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  problem TEXT,
  problem_at TEXT,
  message_id TEXT,
  sent_by_application_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((problem IS NULL) = (problem_at IS NULL)),
  CHECK ((purpose = 'receipt') = (run_id IS NULL)),
  CHECK (purpose <> 'receipt' OR state NOT IN ('lost', 'retired'))
)
-- statement-breakpoint
INSERT INTO chat_deliveries (rowid, id, purpose, action_id, run_id, guild_id, parent_channel_id, thread_id, project_ids_json, text, state, attempts, next_attempt_at, problem, problem_at, message_id, sent_by_application_id, created_at)
SELECT saved_rowid, id, purpose, action_id, run_id, guild_id, parent_channel_id, thread_id, project_ids_json, text, state, attempts, next_attempt_at, problem, problem_at, message_id, sent_by_application_id, created_at FROM chat_deliveries_saved
-- statement-breakpoint
DROP TABLE chat_deliveries_saved
-- statement-breakpoint
CREATE INDEX chat_deliveries_state ON chat_deliveries(state)
-- statement-breakpoint
CREATE INDEX chat_deliveries_message ON chat_deliveries(message_id)
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF
-- statement-breakpoint
CREATE INDEX chat_deliveries_pending_completion ON chat_deliveries(run_id)
WHERE purpose='completion' AND message_id IS NULL AND state IN ('owed','sending','failed','unknown')
-- statement-breakpoint
ALTER TABLE chat_run_reporting ADD COLUMN completion_sequence INTEGER
-- statement-breakpoint
CREATE INDEX run_events_settled ON run_events(run_id,sequence)
WHERE kind='run-settled'
-- statement-breakpoint
-- A timeline sequence distinguishes settlements even when both occur in the same clock tick
-- or reporting does not observe the intervening Active state.
CREATE VIEW chat_settled_cycles AS
SELECT r.id AS run_id, settled.sequence
FROM runs r JOIN run_events settled ON settled.sequence=(
  SELECT MAX(e.sequence) FROM run_events e WHERE e.run_id=r.id AND e.kind='run-settled'
)
WHERE r.settled_at IS NOT NULL AND r.archived_at IS NULL
-- statement-breakpoint
-- Introducing completion notices does not replay the already-Settled Runs of an upgraded host.
INSERT INTO chat_run_reporting (run_id,completion_sequence)
SELECT o.run_id,c.sequence FROM chat_run_origins o JOIN chat_settled_cycles c ON c.run_id=o.run_id
WHERE true
ON CONFLICT(run_id) DO UPDATE SET completion_sequence=excluded.completion_sequence
-- statement-breakpoint
-- Retirement commits with the lifecycle change, before any later dispatch or retry can claim
-- stale work. An already dispatched create can still return its message ID as provenance.
CREATE TRIGGER chat_retire_completion
AFTER UPDATE OF settled_at, archived_at ON runs
WHEN OLD.settled_at IS NOT NULL AND OLD.archived_at IS NULL
  AND (NEW.settled_at IS NULL OR NEW.archived_at IS NOT NULL)
BEGIN
  UPDATE chat_deliveries SET state='retired',next_attempt_at=NULL,problem=NULL,problem_at=NULL
  WHERE run_id=NEW.id AND purpose='completion' AND message_id IS NULL
    AND state IN ('owed','sending','failed','unknown');
END

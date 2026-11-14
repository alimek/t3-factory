-- The request an attributed Human answer applied under, written in the answer's own transaction.
-- Chat control's action identity is that request, so reconciliation proves whether this action
-- answered the occurrence; another client's matching answer leaves it NULL. Existing answers have
-- no attribution.
ALTER TABLE human_occurrences ADD COLUMN answer_request_id TEXT
-- statement-breakpoint
CREATE UNIQUE INDEX human_occurrences_answer_request ON human_occurrences(answer_request_id)
  WHERE answer_request_id IS NOT NULL
-- statement-breakpoint
-- Chat control proposals may now answer one Human occurrence; existing proposals are kept.
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TEMP TABLE chat_proposals_saved AS SELECT * FROM chat_proposals
-- statement-breakpoint
DROP TABLE chat_proposals
-- statement-breakpoint
CREATE TABLE chat_proposals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('start', 'human-answer')),
  parameters_json TEXT NOT NULL,
  -- Requester, context, operation and exact parameters; an identical pending proposal is reused.
  identity TEXT NOT NULL,
  -- The Projects the operation targets; revoking any of them in the context voids the proposal.
  project_ids_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'presented', 'accepting', 'consumed', 'ended')),
  ended_reason TEXT CHECK (ended_reason IN ('failed', 'superseded', 'revoked', 'application')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK ((state = 'ended') = (ended_reason IS NOT NULL)),
  CHECK (state = 'preparing' OR state = 'ended' OR expires_at IS NOT NULL)
)
-- statement-breakpoint
INSERT INTO chat_proposals SELECT * FROM chat_proposals_saved ORDER BY rowid
-- statement-breakpoint
DROP TABLE chat_proposals_saved
-- statement-breakpoint
CREATE INDEX chat_proposals_identity ON chat_proposals(identity, state)
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF

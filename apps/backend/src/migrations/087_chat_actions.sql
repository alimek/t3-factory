-- A Chat control mutation proposal and its requester-bound consent: the exact operation and
-- parameters Factory reviewed, where and for whom. The first confirmation button dispatch fixes
-- `expires_at`; nothing renews it. Revocation, application replacement, supersession and
-- preparation failure end a proposal permanently. Conversation clearing never touches it.
CREATE TABLE chat_proposals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('start')),
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
CREATE INDEX chat_proposals_identity ON chat_proposals(identity, state)
-- statement-breakpoint
-- One confirmed attempt to perform a proposal. The ID is also the shared operation's request
-- identity (a Start's request ID), so an interrupted attempt reconciles the same request.
-- `outcome_json` holds the actual accepted or rejected facts the deterministic receipt states.
CREATE TABLE chat_actions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES chat_proposals(id),
  state TEXT NOT NULL CHECK (state IN ('accepting', 'accepted', 'rejected')),
  started_at TEXT NOT NULL,
  decided_at TEXT,
  outcome_json TEXT,
  CHECK ((state = 'accepting') = (decided_at IS NULL AND outcome_json IS NULL))
)
-- statement-breakpoint
-- The originating thread of a Run started through Chat control; Runs started elsewhere have
-- none. Backend-private: ordinary Run views never expose it.
CREATE TABLE chat_run_origins (
  run_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE REFERENCES chat_actions(id),
  recorded_at TEXT NOT NULL
)
-- statement-breakpoint
-- A Factory message owed to a Discord destination. Intent is persisted before every create:
-- `sending` left by a crash, or any answer that does not prove whether Discord created the
-- message, becomes `unknown` and is never repeated without the host's warned Retry. Destination
-- revocation cancels the debt; the action it reports stays recorded.
CREATE TABLE chat_deliveries (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('receipt')),
  action_id TEXT REFERENCES chat_actions(id),
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  -- The Projects the content concerns; the destination channel must still grant them.
  project_ids_json TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owed', 'sending', 'delivered', 'failed', 'unknown', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  problem TEXT,
  problem_at TEXT,
  message_id TEXT,
  sent_by_application_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((problem IS NULL) = (problem_at IS NULL))
)
-- statement-breakpoint
CREATE INDEX chat_deliveries_state ON chat_deliveries(state)

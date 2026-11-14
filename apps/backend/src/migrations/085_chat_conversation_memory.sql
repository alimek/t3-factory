-- When the conversation last admitted a human invocation into interpretation; inactivity
-- clearing counts from it. NULL counts from the generation's start.
ALTER TABLE chat_conversations ADD COLUMN last_admitted_at TEXT
-- statement-breakpoint
-- A content-free notice owed with the conversation's next published reply: its earlier context
-- was cleared, or its oldest turns were evicted.
ALTER TABLE chat_conversations ADD COLUMN notice TEXT CHECK (notice IN ('cleared', 'evicted'))
-- statement-breakpoint
-- The retained turns of a conversation's current generation: the admitted human snapshot (and
-- the reply target the invoker selected), the bot reply Discord accepted and compact Factory facts
-- from the turn's tool calls. Clearing a conversation deletes its turns.
CREATE TABLE chat_conversation_turns (
  application_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  input TEXT NOT NULL,
  quote_author_id TEXT,
  quote TEXT,
  facts_json TEXT NOT NULL,
  reply TEXT NOT NULL,
  text_bytes INTEGER NOT NULL CHECK (text_bytes >= 0),
  CHECK ((quote_author_id IS NULL) = (quote IS NULL)),
  PRIMARY KEY (application_id, thread_id, turn),
  FOREIGN KEY (application_id, thread_id) REFERENCES chat_conversations(application_id, thread_id)
)
-- statement-breakpoint
-- Content-free markers of admitted invocations whose interpretation has not finished. A marker
-- left by a restart or an interruption owes its thread one coalesced resend notice within fifteen
-- minutes of admission; Off deletes them all.
CREATE TABLE chat_pending_admissions (
  application_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  admitted_at TEXT NOT NULL,
  interrupted TEXT CHECK (interrupted IN ('interrupted', 'model-failed', 'timed-out')),
  PRIMARY KEY (application_id, message_id)
)
-- statement-breakpoint
-- The latest actual conversational failure of the Language model, cleared only by a later
-- successful conversational request. Synthetic tests never write or clear it.
ALTER TABLE chat_model_settings ADD COLUMN runtime_failure_revision INTEGER
-- statement-breakpoint
ALTER TABLE chat_model_settings ADD COLUMN runtime_failure_at TEXT
-- statement-breakpoint
ALTER TABLE chat_model_settings ADD COLUMN runtime_failure_message TEXT

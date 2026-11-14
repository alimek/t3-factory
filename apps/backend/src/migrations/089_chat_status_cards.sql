-- Status cards: a chat-started Run's maintained card in its originating thread is a Factory
-- message like a receipt, so its creates and edits use the same delivery records. SQLite cannot
-- widen a CHECK in place, so the delivery table is rebuilt; existing receipts keep every value.
-- A card's message is `lost` once Discord proved it deleted and `retired` once another
-- application serves; both stay as provenance.
CREATE TABLE chat_deliveries_with_cards (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('receipt', 'status-card')),
  action_id TEXT REFERENCES chat_actions(id),
  -- The Run a status card reports; receipts belong to their action instead.
  run_id TEXT,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  -- The Projects the content concerns; the destination channel must still grant them.
  project_ids_json TEXT NOT NULL,
  -- The text Discord should show: what a create sends, or what an edit brings a card to.
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
  CHECK ((purpose = 'status-card') = (run_id IS NOT NULL)),
  CHECK (purpose = 'status-card' OR state NOT IN ('lost', 'retired'))
)
-- statement-breakpoint
INSERT INTO chat_deliveries_with_cards (id, purpose, action_id, guild_id, parent_channel_id, thread_id, project_ids_json, text, state, attempts, next_attempt_at, problem, problem_at, message_id, sent_by_application_id, created_at)
SELECT id, purpose, action_id, guild_id, parent_channel_id, thread_id, project_ids_json, text, state, attempts, next_attempt_at, problem, problem_at, message_id, sent_by_application_id, created_at FROM chat_deliveries ORDER BY rowid
-- statement-breakpoint
DROP TABLE chat_deliveries
-- statement-breakpoint
ALTER TABLE chat_deliveries_with_cards RENAME TO chat_deliveries
-- statement-breakpoint
CREATE INDEX chat_deliveries_state ON chat_deliveries(state)
-- statement-breakpoint
CREATE INDEX chat_deliveries_message ON chat_deliveries(message_id)
-- statement-breakpoint
-- One maintained status card per chat-started Run: the lineage of its card messages in the
-- originating thread. `delivery_id` is the card Factory maintains now. A card Discord proved
-- deleted is replaced automatically once per lineage; after that only the host's Retry creates
-- one. `reportable` is whether the Run was Active, Snoozed or had pending attention when last
-- captured: only such a card is recreated for a newly configured application, whose card
-- explains once that `replaced_application_id`'s messages are no longer updated. `final` marks
-- an Archived Run whose card already shows it, so later captures skip it.
CREATE TABLE chat_status_cards (
  run_id TEXT PRIMARY KEY REFERENCES chat_run_origins(run_id),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES chat_deliveries(id),
  reportable INTEGER NOT NULL CHECK (reportable IN (0, 1)),
  replacement_used INTEGER NOT NULL DEFAULT 0 CHECK (replacement_used IN (0, 1)),
  replaced_application_id TEXT,
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1))
)

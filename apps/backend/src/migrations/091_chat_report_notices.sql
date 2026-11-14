-- Attention and lifecycle notices: new messages in a chat-started Run's originating thread for
-- new Needs input and Problem matters, for becoming Settled or Archived and for returning to
-- Active, and one catch-up per Run for what accrued while no session could post. They are
-- Factory messages like receipts and status cards, so they use the same delivery records; the
-- CHECK is widened by rebuilding the table, keeping every existing value. A notice's message, like
-- a card's, is `lost` once Discord proved it deleted and `retired` once another application
-- serves or nothing is owed any more.
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TEMP TABLE chat_deliveries_saved AS SELECT * FROM chat_deliveries
-- statement-breakpoint
DROP TABLE chat_deliveries
-- statement-breakpoint
CREATE TABLE chat_deliveries (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('receipt', 'status-card', 'attention', 'lifecycle', 'catch-up')),
  action_id TEXT REFERENCES chat_actions(id),
  -- The Run a status card or notice reports; receipts belong to their action instead.
  run_id TEXT,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  -- The Projects the content concerns; the destination channel must still grant them.
  project_ids_json TEXT NOT NULL,
  -- The text Discord should show: what a create sends, or what an edit brings a message to.
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
INSERT INTO chat_deliveries (id, purpose, action_id, run_id, guild_id, parent_channel_id, thread_id, project_ids_json, text, state, attempts, next_attempt_at, problem, problem_at, message_id, sent_by_application_id, created_at)
SELECT id, purpose, action_id, run_id, guild_id, parent_channel_id, thread_id, project_ids_json, text, state, attempts, next_attempt_at, problem, problem_at, message_id, sent_by_application_id, created_at FROM chat_deliveries_saved ORDER BY rowid
-- statement-breakpoint
DROP TABLE chat_deliveries_saved
-- statement-breakpoint
CREATE INDEX chat_deliveries_state ON chat_deliveries(state)
-- statement-breakpoint
CREATE INDEX chat_deliveries_message ON chat_deliveries(message_id)
-- statement-breakpoint
-- What a chat-started Run's notices have accounted for. `lifecycle` is the lifecycle last
-- reported or taken as baseline (Snoozed counts as Active); NULL means the next capture with
-- access takes the Run's current state as its baseline without a message, as after a revocation.
-- `reference` and `title` name the Run in notices composed without a Run read. `final` marks an
-- Archived Run whose notices owe nothing more, so later captures skip it.
CREATE TABLE chat_run_reporting (
  run_id TEXT PRIMARY KEY REFERENCES chat_run_origins(run_id),
  lifecycle TEXT CHECK (lifecycle IN ('active', 'settled', 'archived')),
  reference TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1))
)
-- statement-breakpoint
-- Chat-started Runs recorded before notices existed start from their current state.
INSERT INTO chat_run_reporting (run_id, lifecycle) SELECT run_id, NULL FROM chat_run_origins
-- statement-breakpoint
-- One notice message: an attention notice lists new matters, a lifecycle notice reports a
-- lifecycle change, and a catch-up combines both for what accrued while no session served.
-- `lifecycle` is the change it reports (NULL when it reports none) and `previous_lifecycle`
-- what was accounted for before it, so a change undone before the notice was posted is not
-- reported. `late` marks a lifecycle change posted after the fact; `application_notice` that the
-- Run's card was another application's and gets no replacement.
CREATE TABLE chat_report_notices (
  delivery_id TEXT PRIMARY KEY REFERENCES chat_deliveries(id),
  run_id TEXT NOT NULL REFERENCES chat_run_origins(run_id),
  lifecycle TEXT CHECK (lifecycle IN ('active', 'settled', 'archived')),
  previous_lifecycle TEXT CHECK (previous_lifecycle IN ('active', 'settled', 'archived')),
  lifecycle_at TEXT,
  late INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
  application_notice INTEGER NOT NULL DEFAULT 0 CHECK (application_notice IN (0, 1)),
  CHECK ((lifecycle IS NULL) = (lifecycle_at IS NULL))
)
-- statement-breakpoint
CREATE INDEX chat_report_notices_run ON chat_report_notices(run_id)
-- statement-breakpoint
-- Each attention matter of a chat-started Run reporting has seen, by its attention record ID.
-- `notice_id` is the one notice that announced it; NULL when it was pending at a baseline and is
-- shown only on the status card. Kind, Block name and appearance time are what notices show.
CREATE TABLE chat_report_matters (
  matter_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES chat_run_origins(run_id),
  notice_id TEXT REFERENCES chat_report_notices(delivery_id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'native-request', 'conversation-waiting', 'missing-report', 'execution-failed', 'report-problem')),
  block TEXT NOT NULL,
  appeared_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1))
)
-- statement-breakpoint
CREATE INDEX chat_report_matters_run ON chat_report_matters(run_id)
-- statement-breakpoint
CREATE INDEX chat_report_matters_notice ON chat_report_matters(notice_id)

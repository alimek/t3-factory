-- The Access section of Chat control: allowed Discord users and allowed parent channels with the
-- Factory Projects each grants. It has its own revision, independent of the Language model and the
-- Discord connection. Every installation starts with empty Access, which admits nobody.
CREATE TABLE chat_access_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT,
  CHECK ((revision = 0) = (saved_at IS NULL))
)
-- statement-breakpoint
INSERT INTO chat_access_settings (singleton) VALUES (1)
-- statement-breakpoint
CREATE TABLE chat_access_users (
  user_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL
)
-- statement-breakpoint
CREATE TABLE chat_access_channels (
  channel_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL
)
-- statement-breakpoint
-- project_id has no foreign key: a granted Project that Factory no longer knows stays listed,
-- visibly unresolved, and grants nothing.
CREATE TABLE chat_access_channel_projects (
  channel_id TEXT NOT NULL REFERENCES chat_access_channels(channel_id),
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (channel_id, project_id)
)
-- statement-breakpoint
-- The operating connection's latest failure that needs correction and an explicit Retry. It keeps
-- a persisted On intent from reconnecting by itself after a restart.
ALTER TABLE chat_control_state ADD COLUMN rejected_outcome TEXT CHECK (
  rejected_outcome IN (
    'identity-mismatch',
    'token-rejected',
    'intent-disallowed',
    'failed'
  )
)
-- statement-breakpoint
ALTER TABLE chat_control_state ADD COLUMN rejected_message TEXT
-- statement-breakpoint
ALTER TABLE chat_control_state ADD COLUMN rejected_at TEXT
-- statement-breakpoint
-- One shared conversation per Discord thread of the configured application; the database itself
-- belongs to one Factory installation. A reset or clearing rule advances the generation, which
-- fences everything recorded under an earlier one.
CREATE TABLE chat_conversations (
  application_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  generation_started_at TEXT NOT NULL,
  PRIMARY KEY (application_id, thread_id)
)
-- statement-breakpoint
-- Content-free markers of Discord messages and interactions Factory already took, so a repeated
-- delivery never admits twice or creates a second thread.
CREATE TABLE chat_ingress_events (
  application_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (application_id, event_id)
)
-- statement-breakpoint
CREATE INDEX chat_ingress_events_received ON chat_ingress_events (received_at)
-- statement-breakpoint
-- Chat SDK state: thread subscriptions and its key-value cache with expiry (message
-- deduplication and turn markers). Expiry is epoch milliseconds; NULL never expires.
CREATE TABLE chat_sdk_subscriptions (
  thread_id TEXT PRIMARY KEY
)
-- statement-breakpoint
CREATE TABLE chat_sdk_cache (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER
)

-- Chat control's persisted On/Off state. Every installation, new or upgraded, starts Off; no
-- existing data changes.
CREATE TABLE chat_control_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
)
-- statement-breakpoint
INSERT INTO chat_control_state (singleton) VALUES (1)
-- statement-breakpoint
-- The committed Language model section. Its optional key lives in an owner-only credential file
-- outside SQLite; key_stage names that file, and a staged file no row names is never used. Each
-- save commits the whole section as the next revision. The latest owner-requested synthetic Test
-- is dated evidence for the revision it tested, not conversational health.
CREATE TABLE chat_model_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider_kind TEXT CHECK (provider_kind IN ('openai-compatible', 'anthropic')),
  base_url TEXT,
  model TEXT,
  key_stage TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT,
  test_revision INTEGER,
  test_at TEXT,
  test_outcome TEXT CHECK (test_outcome IN ('succeeded', 'failed')),
  test_message TEXT,
  CHECK ((revision = 0) = (saved_at IS NULL)),
  CHECK ((test_revision IS NULL) = (test_at IS NULL)),
  CHECK ((test_revision IS NULL) = (test_outcome IS NULL)),
  CHECK ((test_revision IS NULL) = (test_message IS NULL))
)
-- statement-breakpoint
INSERT INTO chat_model_settings (singleton) VALUES (1)

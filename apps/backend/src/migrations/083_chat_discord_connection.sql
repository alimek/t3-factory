-- The committed Discord connection section of Chat control, independent of the Language model and
-- Access sections. Its bot token lives in an owner-only credential file outside SQLite; token_stage
-- names that file, and a staged file no row names is never used. Each save commits the whole section
-- as the next revision. The latest owner-requested connection-only check is dated evidence for the
-- revision it checked, not operational health.
CREATE TABLE chat_discord_connection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  application_id TEXT,
  public_key TEXT,
  token_stage TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT,
  check_revision INTEGER,
  check_at TEXT,
  check_outcome TEXT CHECK (
    check_outcome IN (
      'verified',
      'identity-mismatch',
      'token-rejected',
      'intent-disallowed',
      'unreachable',
      'timed-out',
      'failed'
    )
  ),
  check_message TEXT,
  CHECK ((revision = 0) = (saved_at IS NULL)),
  CHECK ((check_revision IS NULL) = (check_at IS NULL)),
  CHECK ((check_revision IS NULL) = (check_outcome IS NULL)),
  CHECK ((check_revision IS NULL) = (check_message IS NULL))
)
-- statement-breakpoint
INSERT INTO chat_discord_connection (singleton) VALUES (1)

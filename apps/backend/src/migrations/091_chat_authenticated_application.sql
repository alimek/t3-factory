-- Chat control no longer configures an expected Application ID. Factory operates as the application
-- Discord reports for the authenticated Gateway session and records it in chat_control_state; a
-- session of another application is an application replacement. The configured Application ID
-- carries over as the recorded application, because existing conversations, consent and messages
-- belong to it. SQLite cannot narrow a CHECK in place, so both tables are rebuilt.
CREATE TABLE chat_control_state_authenticated (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- The application the latest operating session authenticated as; null until one did.
  application_id TEXT,
  rejected_outcome TEXT CHECK (
    rejected_outcome IN ('token-rejected', 'intent-disallowed', 'failed')
  ),
  rejected_message TEXT,
  rejected_at TEXT
)
-- statement-breakpoint
-- A connection rejected because its token belonged to another application stays rejected until the
-- owner retries; retrying now connects that application as a replacement.
INSERT INTO chat_control_state_authenticated (singleton, enabled, application_id, rejected_outcome, rejected_message, rejected_at)
SELECT s.singleton, s.enabled, d.application_id,
  CASE s.rejected_outcome WHEN 'identity-mismatch' THEN 'failed' ELSE s.rejected_outcome END,
  CASE s.rejected_outcome
    WHEN 'identity-mismatch' THEN 'Discord authenticated the saved bot token as a different application than the one Factory operated as, so Chat control stopped. Retrying connects that application and replaces the previous one.'
    ELSE s.rejected_message
  END,
  s.rejected_at
FROM chat_control_state s LEFT JOIN chat_discord_connection d ON d.singleton = 1
-- statement-breakpoint
DROP TABLE chat_control_state
-- statement-breakpoint
ALTER TABLE chat_control_state_authenticated RENAME TO chat_control_state
-- statement-breakpoint
-- The connection section keeps the token and Public Key. A check reports the application Discord
-- authenticated; checks before this migration recorded it only in their message, which Factory
-- wrote in one fixed form per outcome. An identity mismatch reached a ready session, which is a
-- verified check now.
CREATE TABLE chat_discord_connection_authenticated (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  public_key TEXT,
  token_stage TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT,
  check_revision INTEGER,
  check_at TEXT,
  check_outcome TEXT CHECK (
    check_outcome IN (
      'verified',
      'token-rejected',
      'intent-disallowed',
      'unreachable',
      'timed-out',
      'failed'
    )
  ),
  check_application_id TEXT,
  check_message TEXT,
  CHECK ((revision = 0) = (saved_at IS NULL)),
  CHECK ((check_revision IS NULL) = (check_at IS NULL)),
  CHECK ((check_revision IS NULL) = (check_outcome IS NULL)),
  CHECK ((check_revision IS NULL) = (check_message IS NULL)),
  CHECK ((check_outcome IS 'verified') = (check_application_id IS NOT NULL))
)
-- statement-breakpoint
INSERT INTO chat_discord_connection_authenticated (singleton, public_key, token_stage, revision, saved_at, check_revision, check_at, check_outcome, check_application_id, check_message)
SELECT singleton, public_key, token_stage, revision, saved_at, check_revision, check_at,
  CASE check_outcome WHEN 'identity-mismatch' THEN 'verified' ELSE check_outcome END,
  checked_application,
  CASE check_outcome
    WHEN 'identity-mismatch' THEN 'Discord accepted the token for application ' || checked_application || ' and the Gateway session became ready. Factory disconnected after the check.'
    ELSE check_message
  END
FROM (
  SELECT *,
    CASE check_outcome
      WHEN 'verified' THEN substr(check_message, 44, instr(check_message, ' and the Gateway session') - 44)
      WHEN 'identity-mismatch' THEN substr(check_message, 42, instr(check_message, ', not the configured') - 42)
    END AS checked_application
  FROM chat_discord_connection
)
-- statement-breakpoint
DROP TABLE chat_discord_connection
-- statement-breakpoint
ALTER TABLE chat_discord_connection_authenticated RENAME TO chat_discord_connection

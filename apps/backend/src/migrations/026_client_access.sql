-- Approved remote clients: one row per desktop installation or browser profile.
-- Only a SHA-256 hash of each client's random secret is stored; the label is a display hint.
CREATE TABLE client_grants (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'browser')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  secret_hash TEXT NOT NULL,
  verification_code TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  last_seen_at TEXT
)
-- statement-breakpoint
CREATE INDEX client_grants_status ON client_grants(status, requested_at)

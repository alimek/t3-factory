CREATE TABLE t3_authorization_contexts (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  authorization_identity TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
-- statement-breakpoint
CREATE TABLE t3_connection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  endpoint TEXT NOT NULL,
  context_id TEXT REFERENCES t3_authorization_contexts(id)
)

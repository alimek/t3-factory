-- Existing bootstrap bytes and accepted payloads retain version zero and no child authority.
ALTER TABLE run_coordinators ADD COLUMN instruction_version INTEGER NOT NULL DEFAULT 0 CHECK(instruction_version IN (0,1));
-- statement-breakpoint
CREATE TABLE run_coordinator_commands (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  request_key TEXT NOT NULL UNIQUE,
  invocation_json TEXT NOT NULL,
  invocation_fingerprint TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  send_key TEXT NOT NULL UNIQUE,
  send_json TEXT,
  send_fingerprint TEXT,
  retry_scope TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','uncertain','issued','accepted')),
  parent_execution_id TEXT,
  accepted_json TEXT,
  thread_id TEXT UNIQUE,
  execution_id TEXT,
  problem TEXT,
  context_granted INTEGER NOT NULL DEFAULT 0 CHECK(context_granted IN (0,1))
);
-- statement-breakpoint
CREATE TABLE run_coordinator_obligations (
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  source_key TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY(run_id,source_key)
);

-- Source release is irreversible and separate from recipient availability.
-- Older presentation/completion timestamps cannot manufacture this authority.
CREATE TABLE coordinator_releases (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  report_id TEXT NOT NULL UNIQUE REFERENCES runtime_reports(id),
  generation INTEGER NOT NULL,
  context_id TEXT NOT NULL,
  frontier_json TEXT NOT NULL,
  released_at TEXT NOT NULL
);

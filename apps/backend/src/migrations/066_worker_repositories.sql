CREATE TABLE worker_repositories (
  binding_id TEXT PRIMARY KEY NOT NULL REFERENCES run_thread_bindings(id),
  branch TEXT,
  updated_at TEXT NOT NULL
)
-- statement-breakpoint
CREATE TABLE worker_pull_requests (
  binding_id TEXT NOT NULL REFERENCES worker_repositories(binding_id),
  host TEXT NOT NULL,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  url TEXT NOT NULL,
  state TEXT CHECK (state IN ('open', 'closed', 'merged')),
  PRIMARY KEY (binding_id, host, repository, number)
)
-- statement-breakpoint
CREATE INDEX run_activity_by_run ON run_events(run_id, observed_at DESC)
WHERE kind IN ('execution-observed','report-accepted','working-reported','human-answered','attention-appeared','handoff-released','run-settled','run-activated')

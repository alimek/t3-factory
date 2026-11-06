CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  availability TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(endpoint, environment_id, project_id)
)
-- statement-breakpoint
CREATE TABLE project_selection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT REFERENCES projects(id)
)

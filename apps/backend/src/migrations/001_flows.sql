CREATE TABLE flows (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  revision INTEGER NOT NULL CHECK (revision > 0),
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- statement-breakpoint
CREATE INDEX flows_listing ON flows (created_at DESC, id ASC);

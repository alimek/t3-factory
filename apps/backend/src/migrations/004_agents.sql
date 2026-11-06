CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  prompt TEXT NOT NULL CHECK (length(prompt) <= 120000),
  revision INTEGER NOT NULL CHECK (revision > 0),
  environment_id TEXT NOT NULL CHECK (length(trim(environment_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK (length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
  model_options_json TEXT NOT NULL CHECK (json_valid(model_options_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- statement-breakpoint
CREATE INDEX agents_listing ON agents (updated_at DESC, id ASC);

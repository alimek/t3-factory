-- Agents become immutable revisions. The `agents` row keeps only identity, creation time
-- and removal; every save appends a revision holding the prompt and execution settings.
-- Each current Agent becomes its first stored revision under its existing counter.
CREATE TABLE agent_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  prompt TEXT NOT NULL CHECK (length(prompt) <= 120000),
  environment_id TEXT NOT NULL CHECK (length(trim(environment_id)) > 0),
  provider_instance_id TEXT NOT NULL CHECK (length(trim(provider_instance_id)) > 0),
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),
  model_options_json TEXT NOT NULL CHECK (json_valid(model_options_json)),
  saved_at TEXT NOT NULL,
  UNIQUE (agent_id, revision)
)
-- statement-breakpoint
INSERT INTO agent_revisions (
  id, agent_id, revision, name, prompt, environment_id, provider_instance_id, model_id,
  model_options_json, saved_at
)
SELECT
  substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
    || substr('89ab', 1 + (unicode(substr(h, 17, 1)) % 4), 1) || substr(h, 18, 3) || '-'
    || substr(h, 21, 12),
  id, revision, name, prompt, environment_id, provider_instance_id, model_id,
  model_options_json, updated_at
FROM (SELECT lower(hex(randomblob(16))) AS h, * FROM agents)
-- statement-breakpoint
DROP INDEX agents_listing
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN name
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN prompt
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN revision
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN environment_id
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN provider_instance_id
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN model_id
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN model_options_json
-- statement-breakpoint
ALTER TABLE agents DROP COLUMN updated_at
-- statement-breakpoint
-- Removal hides an Agent from Studio and Start but keeps every revision it saved.
ALTER TABLE agents ADD COLUMN removed_at TEXT
-- statement-breakpoint
CREATE TRIGGER immutable_agent_revision_update BEFORE UPDATE ON agent_revisions BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_agent_revision_delete BEFORE DELETE ON agent_revisions BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END
-- statement-breakpoint
-- Hard deletion is retired: a removed Agent keeps its identity for its revisions.
CREATE TRIGGER retained_agent_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'Agents are removed, not deleted'); END

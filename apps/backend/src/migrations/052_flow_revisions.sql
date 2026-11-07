-- Flows become immutable relational revisions. The `flows` row keeps only identity,
-- creation time and removal; every save appends a revision whose graph is owned rows.
-- Each current graph becomes that Flow's first stored revision under its existing counter.
CREATE TABLE flow_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  flow_id TEXT NOT NULL REFERENCES flows(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  input_x REAL NOT NULL,
  input_y REAL NOT NULL,
  saved_at TEXT NOT NULL,
  UNIQUE (flow_id, revision)
)
-- statement-breakpoint
CREATE TABLE flow_revision_blocks (
  flow_revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
  block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
  name TEXT NOT NULL,
  -- Unresolved by design: drafts may name a missing Agent, and history outlives the Agent.
  agent_id TEXT CHECK (kind = 'agent' OR agent_id IS NULL),
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (flow_revision_id, block_id),
  UNIQUE (flow_revision_id, ordinal)
)
-- statement-breakpoint
CREATE TABLE flow_revision_exits (
  flow_revision_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  exit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completion', 'assessment-ok', 'assessment-fail', 'custom')),
  requires_feedback INTEGER NOT NULL CHECK (requires_feedback IN (0, 1)),
  PRIMARY KEY (flow_revision_id, block_id, exit_id),
  UNIQUE (flow_revision_id, block_id, ordinal),
  FOREIGN KEY (flow_revision_id, block_id) REFERENCES flow_revision_blocks(flow_revision_id, block_id)
)
-- statement-breakpoint
CREATE TABLE flow_revision_connections (
  flow_revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_block_id TEXT NOT NULL,
  exit_id TEXT NOT NULL,
  target_block_id TEXT NOT NULL,
  PRIMARY KEY (flow_revision_id, ordinal),
  UNIQUE (flow_revision_id, source_block_id, exit_id, target_block_id),
  FOREIGN KEY (flow_revision_id, source_block_id, exit_id)
    REFERENCES flow_revision_exits(flow_revision_id, block_id, exit_id),
  FOREIGN KEY (flow_revision_id, target_block_id)
    REFERENCES flow_revision_blocks(flow_revision_id, block_id)
)
-- statement-breakpoint
CREATE TABLE flow_revision_input_targets (
  flow_revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  block_id TEXT NOT NULL,
  PRIMARY KEY (flow_revision_id, ordinal),
  UNIQUE (flow_revision_id, block_id),
  FOREIGN KEY (flow_revision_id, block_id) REFERENCES flow_revision_blocks(flow_revision_id, block_id)
)
-- statement-breakpoint
INSERT INTO flow_revisions (id, flow_id, revision, name, input_x, input_y, saved_at)
SELECT
  substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
    || substr('89ab', 1 + (unicode(substr(h, 17, 1)) % 4), 1) || substr(h, 18, 3) || '-'
    || substr(h, 21, 12),
  id, revision, name,
  json_extract(graph_json, '$.flowInput.position.x'),
  json_extract(graph_json, '$.flowInput.position.y'),
  updated_at
FROM (SELECT lower(hex(randomblob(16))) AS h, * FROM flows)
-- statement-breakpoint
INSERT INTO flow_revision_blocks (flow_revision_id, block_id, ordinal, kind, name, agent_id, x, y)
SELECT r.id, json_extract(b.value, '$.id'), b.key, json_extract(b.value, '$.kind'),
  json_extract(b.value, '$.name'), json_extract(b.value, '$.agentId'),
  json_extract(b.value, '$.position.x'), json_extract(b.value, '$.position.y')
FROM flows f JOIN flow_revisions r ON r.flow_id = f.id, json_each(f.graph_json, '$.blocks') b
-- statement-breakpoint
INSERT INTO flow_revision_exits (
  flow_revision_id, block_id, exit_id, ordinal, name, description, outcome, requires_feedback
)
SELECT r.id, json_extract(b.value, '$.id'), json_extract(e.value, '$.id'), e.key,
  json_extract(e.value, '$.name'), json_extract(e.value, '$.description'),
  json_extract(e.value, '$.outcome'), json_extract(e.value, '$.requiresFeedback')
FROM flows f JOIN flow_revisions r ON r.flow_id = f.id, json_each(f.graph_json, '$.blocks') b,
  json_each(b.value, '$.exits') e
-- statement-breakpoint
INSERT INTO flow_revision_connections (
  flow_revision_id, ordinal, source_block_id, exit_id, target_block_id
)
SELECT r.id, c.key, json_extract(c.value, '$.sourceBlockId'), json_extract(c.value, '$.exitId'),
  json_extract(c.value, '$.targetBlockId')
FROM flows f JOIN flow_revisions r ON r.flow_id = f.id, json_each(f.graph_json, '$.connections') c
-- statement-breakpoint
INSERT INTO flow_revision_input_targets (flow_revision_id, ordinal, block_id)
SELECT r.id, t.key, t.value
FROM flows f JOIN flow_revisions r ON r.flow_id = f.id,
  json_each(f.graph_json, '$.flowInput.targetBlockIds') t
-- statement-breakpoint
ALTER TABLE flows DROP COLUMN graph_json
-- statement-breakpoint
ALTER TABLE flows DROP COLUMN name
-- statement-breakpoint
ALTER TABLE flows DROP COLUMN revision
-- statement-breakpoint
ALTER TABLE flows DROP COLUMN updated_at
-- statement-breakpoint
-- Removal hides a Flow from Studio and Start but keeps every revision it saved.
ALTER TABLE flows ADD COLUMN removed_at TEXT
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_update BEFORE UPDATE ON flow_revisions BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_delete BEFORE DELETE ON flow_revisions BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_block_update BEFORE UPDATE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_block_delete BEFORE DELETE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_exit_update BEFORE UPDATE ON flow_revision_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_exit_delete BEFORE DELETE ON flow_revision_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_connection_update BEFORE UPDATE ON flow_revision_connections BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_connection_delete BEFORE DELETE ON flow_revision_connections BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_input_target_update BEFORE UPDATE ON flow_revision_input_targets BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_input_target_delete BEFORE DELETE ON flow_revision_input_targets BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
-- Hard deletion is retired: a removed Flow keeps its identity for its revisions.
CREATE TRIGGER retained_flow_delete BEFORE DELETE ON flows BEGIN SELECT RAISE(ABORT, 'Flows are removed, not deleted'); END

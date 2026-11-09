-- Agents declare their exits; a Flow block inherits them, may hide some and may add Flow-local
-- exits. The exit outcome classification is removed and "message required" replaces the
-- feedback flag. Every Flow revision, including those Runs captured, is converted in place.
-- Existing Agents start with no exits, so each Agent block keeps its exits as Flow-local exits
-- with the same IDs: its wires, reports and handoffs stay valid. Human steps get the fixed
-- Approve and Request changes exits by their old feedback flag; wires that now leave the same
-- exit merge into one fan-out without duplicate block-to-block wires, and Human answers and their
-- handoffs name the new exit. Other recorded exits are unchanged.
CREATE TABLE agent_revision_exits (
  agent_revision_id TEXT NOT NULL REFERENCES agent_revisions(id),
  exit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description TEXT NOT NULL,
  message_required INTEGER NOT NULL CHECK (message_required IN (0, 1)),
  PRIMARY KEY (agent_revision_id, exit_id),
  UNIQUE (agent_revision_id, ordinal)
)
-- statement-breakpoint
CREATE TRIGGER immutable_agent_revision_exit_update BEFORE UPDATE ON agent_revision_exits BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_agent_revision_exit_delete BEFORE DELETE ON agent_revision_exits BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END
-- statement-breakpoint
-- Inherited exit IDs a Flow revision hides on an Agent block, unresolved by design: the Agent may
-- remove the exit later, and readiness then ignores the entry.
CREATE TABLE flow_revision_hidden_exits (
  flow_revision_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  exit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (flow_revision_id, block_id, exit_id),
  UNIQUE (flow_revision_id, block_id, ordinal),
  FOREIGN KEY (flow_revision_id, block_id) REFERENCES flow_revision_blocks(flow_revision_id, block_id)
)
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_hidden_exit_update BEFORE UPDATE ON flow_revision_hidden_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_hidden_exit_delete BEFORE DELETE ON flow_revision_hidden_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TEMP TABLE human_exit_map AS
SELECT e.flow_revision_id, e.block_id, e.exit_id AS old_exit_id,
  CASE e.requires_feedback WHEN 1 THEN 'request-changes' ELSE 'approve' END AS exit_id
FROM flow_revision_exits e
JOIN flow_revision_blocks b ON b.flow_revision_id = e.flow_revision_id AND b.block_id = e.block_id
WHERE b.kind = 'human'
-- statement-breakpoint
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
-- Wires reference their source block; its Agent's exits are resolved by readiness, not a key.
CREATE TABLE flow_revision_connections_merged (
  flow_revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_block_id TEXT NOT NULL,
  exit_id TEXT NOT NULL,
  target_block_id TEXT NOT NULL,
  PRIMARY KEY (flow_revision_id, ordinal),
  UNIQUE (flow_revision_id, source_block_id, exit_id, target_block_id),
  FOREIGN KEY (flow_revision_id, source_block_id)
    REFERENCES flow_revision_blocks(flow_revision_id, block_id),
  FOREIGN KEY (flow_revision_id, target_block_id)
    REFERENCES flow_revision_blocks(flow_revision_id, block_id)
)
-- statement-breakpoint
INSERT INTO flow_revision_connections_merged (
  flow_revision_id, ordinal, source_block_id, exit_id, target_block_id
)
SELECT c.flow_revision_id,
  row_number() OVER (PARTITION BY c.flow_revision_id ORDER BY min(c.ordinal)) - 1,
  c.source_block_id, coalesce(m.exit_id, c.exit_id), c.target_block_id
FROM flow_revision_connections c
LEFT JOIN human_exit_map m ON m.flow_revision_id = c.flow_revision_id
  AND m.block_id = c.source_block_id AND m.old_exit_id = c.exit_id
GROUP BY c.flow_revision_id, c.source_block_id, coalesce(m.exit_id, c.exit_id), c.target_block_id
-- statement-breakpoint
DROP TABLE flow_revision_connections
-- statement-breakpoint
ALTER TABLE flow_revision_connections_merged RENAME TO flow_revision_connections
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_connection_update BEFORE UPDATE ON flow_revision_connections BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_connection_delete BEFORE DELETE ON flow_revision_connections BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
-- flow_revision_exits now holds only the Flow-local exits of Agent blocks.
DROP TRIGGER immutable_flow_revision_exit_delete
-- statement-breakpoint
DELETE FROM flow_revision_exits WHERE EXISTS (
  SELECT 1 FROM human_exit_map m
  WHERE m.flow_revision_id = flow_revision_exits.flow_revision_id
    AND m.block_id = flow_revision_exits.block_id)
-- statement-breakpoint
CREATE TRIGGER immutable_flow_revision_exit_delete BEFORE DELETE ON flow_revision_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END
-- statement-breakpoint
ALTER TABLE flow_revision_exits DROP COLUMN outcome
-- statement-breakpoint
ALTER TABLE flow_revision_exits RENAME COLUMN requires_feedback TO message_required
-- statement-breakpoint
UPDATE human_occurrences SET exit_id = (
  SELECT m.exit_id FROM runs r
  JOIN human_exit_map m ON m.flow_revision_id = r.flow_revision_id
    AND m.block_id = human_occurrences.block_id AND m.old_exit_id = human_occurrences.exit_id
  WHERE r.id = human_occurrences.run_id)
WHERE exit_id IS NOT NULL
-- statement-breakpoint
-- A Human answer's handoffs carry its occurrence and the exit it chose.
UPDATE operation_intents SET exit_id = (
  SELECT m.exit_id FROM runs r
  JOIN human_exit_map m ON m.flow_revision_id = r.flow_revision_id
    AND m.block_id = operation_intents.source_block_id AND m.old_exit_id = operation_intents.exit_id
  WHERE r.id = operation_intents.run_id)
WHERE occurrence_id IS NOT NULL
-- statement-breakpoint
DROP TABLE human_exit_map
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF

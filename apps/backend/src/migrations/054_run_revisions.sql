-- A Run references the Flow revision it started with and freezes one revision of every Agent
-- that Flow references, independent of activations. Each Agent activation references its
-- frozen revision; Human steps have no activation and so no Agent revision.
-- Existing Runs are converted from their stored snapshots. A snapshot whose Flow or Agent
-- revision is no longer stored (edited or removed later) becomes that revision again, and a
-- removed definition regains a removed identity row. Nothing beyond the snapshots is invented.
CREATE UNIQUE INDEX agent_revisions_identity ON agent_revisions(agent_id, id)
-- statement-breakpoint
CREATE TABLE run_agent_revisions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_id),
  FOREIGN KEY (agent_id, agent_revision_id) REFERENCES agent_revisions(agent_id, id)
)
-- statement-breakpoint
ALTER TABLE runs ADD COLUMN flow_revision_id TEXT REFERENCES flow_revisions(id)
-- statement-breakpoint
ALTER TABLE run_activations ADD COLUMN agent_revision_id TEXT REFERENCES agent_revisions(id)
-- statement-breakpoint
CREATE TEMP TABLE snapshot_flows AS
SELECT run_id, json_extract(snapshot_json, '$.flow') AS flow FROM run_snapshots
-- statement-breakpoint
CREATE TEMP TABLE snapshot_agents AS
SELECT s.run_id, a.value AS agent
FROM run_snapshots s, json_each(s.snapshot_json, '$.agents') a
-- statement-breakpoint
INSERT INTO flows (id, created_at, removed_at)
SELECT json_extract(flow, '$.id'), min(json_extract(flow, '$.createdAt')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM snapshot_flows
WHERE NOT EXISTS (SELECT 1 FROM flows WHERE id = json_extract(flow, '$.id'))
GROUP BY json_extract(flow, '$.id')
-- statement-breakpoint
INSERT INTO agents (id, created_at, removed_at)
SELECT json_extract(agent, '$.id'), min(json_extract(agent, '$.createdAt')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM snapshot_agents
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = json_extract(agent, '$.id'))
GROUP BY json_extract(agent, '$.id')
-- statement-breakpoint
-- One snapshot per missing (Flow, revision); the random key is stored before it is formatted.
CREATE TEMP TABLE missing_flow_revisions AS
SELECT lower(hex(randomblob(16))) AS h, flow FROM (
  SELECT flow, min(run_id) FROM snapshot_flows
  GROUP BY json_extract(flow, '$.id'), json_extract(flow, '$.revision'))
WHERE NOT EXISTS (
  SELECT 1 FROM flow_revisions
  WHERE flow_id = json_extract(flow, '$.id') AND revision = json_extract(flow, '$.revision'))
-- statement-breakpoint
CREATE TEMP TABLE restored_flow_revisions AS
SELECT
  substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
    || substr('89ab', 1 + (unicode(substr(h, 17, 1)) % 4), 1) || substr(h, 18, 3) || '-'
    || substr(h, 21, 12) AS id,
  flow
FROM missing_flow_revisions
-- statement-breakpoint
INSERT INTO flow_revisions (id, flow_id, revision, name, input_x, input_y, saved_at)
SELECT id, json_extract(flow, '$.id'), json_extract(flow, '$.revision'),
  json_extract(flow, '$.name'),
  json_extract(flow, '$.graph.flowInput.position.x'),
  json_extract(flow, '$.graph.flowInput.position.y'),
  json_extract(flow, '$.updatedAt')
FROM restored_flow_revisions
-- statement-breakpoint
INSERT INTO flow_revision_blocks (flow_revision_id, block_id, ordinal, kind, name, agent_id, x, y)
SELECT r.id, json_extract(b.value, '$.id'), b.key, json_extract(b.value, '$.kind'),
  json_extract(b.value, '$.name'), json_extract(b.value, '$.agentId'),
  json_extract(b.value, '$.position.x'), json_extract(b.value, '$.position.y')
FROM restored_flow_revisions r, json_each(r.flow, '$.graph.blocks') b
-- statement-breakpoint
INSERT INTO flow_revision_exits (
  flow_revision_id, block_id, exit_id, ordinal, name, description, outcome, requires_feedback
)
SELECT r.id, json_extract(b.value, '$.id'), json_extract(e.value, '$.id'), e.key,
  json_extract(e.value, '$.name'), json_extract(e.value, '$.description'),
  json_extract(e.value, '$.outcome'), json_extract(e.value, '$.requiresFeedback')
FROM restored_flow_revisions r, json_each(r.flow, '$.graph.blocks') b,
  json_each(b.value, '$.exits') e
-- statement-breakpoint
INSERT INTO flow_revision_connections (
  flow_revision_id, ordinal, source_block_id, exit_id, target_block_id
)
SELECT r.id, c.key, json_extract(c.value, '$.sourceBlockId'), json_extract(c.value, '$.exitId'),
  json_extract(c.value, '$.targetBlockId')
FROM restored_flow_revisions r, json_each(r.flow, '$.graph.connections') c
-- statement-breakpoint
INSERT INTO flow_revision_input_targets (flow_revision_id, ordinal, block_id)
SELECT r.id, t.key, t.value
FROM restored_flow_revisions r, json_each(r.flow, '$.graph.flowInput.targetBlockIds') t
-- statement-breakpoint
CREATE TEMP TABLE missing_agent_revisions AS
SELECT lower(hex(randomblob(16))) AS h, agent FROM (
  SELECT agent, min(run_id) FROM snapshot_agents
  GROUP BY json_extract(agent, '$.id'), json_extract(agent, '$.revision'))
WHERE NOT EXISTS (
  SELECT 1 FROM agent_revisions
  WHERE agent_id = json_extract(agent, '$.id') AND revision = json_extract(agent, '$.revision'))
-- statement-breakpoint
INSERT INTO agent_revisions (
  id, agent_id, revision, name, prompt, environment_id, provider_instance_id, model_id,
  model_options_json, saved_at
)
SELECT
  substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
    || substr('89ab', 1 + (unicode(substr(h, 17, 1)) % 4), 1) || substr(h, 18, 3) || '-'
    || substr(h, 21, 12),
  json_extract(agent, '$.id'), json_extract(agent, '$.revision'), json_extract(agent, '$.name'),
  json_extract(agent, '$.prompt'), json_extract(agent, '$.execution.environmentId'),
  json_extract(agent, '$.execution.providerInstanceId'), json_extract(agent, '$.execution.modelId'),
  json(json_extract(agent, '$.execution.modelOptions')), json_extract(agent, '$.updatedAt')
FROM missing_agent_revisions
-- statement-breakpoint
UPDATE runs SET flow_revision_id = (
  SELECT r.id FROM snapshot_flows s
  JOIN flow_revisions r ON r.flow_id = json_extract(s.flow, '$.id')
    AND r.revision = json_extract(s.flow, '$.revision')
  WHERE s.run_id = runs.id)
-- statement-breakpoint
INSERT INTO run_agent_revisions (run_id, agent_id, agent_revision_id)
SELECT s.run_id, r.agent_id, r.id FROM snapshot_agents s
JOIN agent_revisions r ON r.agent_id = json_extract(s.agent, '$.id')
  AND r.revision = json_extract(s.agent, '$.revision')
-- statement-breakpoint
UPDATE run_activations SET agent_revision_id = (
  SELECT f.agent_revision_id FROM runs r
  JOIN flow_revision_blocks b ON b.flow_revision_id = r.flow_revision_id
    AND b.block_id = run_activations.block_id
  JOIN run_agent_revisions f ON f.run_id = r.id AND f.agent_id = b.agent_id
  WHERE r.id = run_activations.run_id)
-- statement-breakpoint
DROP TABLE missing_agent_revisions
-- statement-breakpoint
DROP TABLE restored_flow_revisions
-- statement-breakpoint
DROP TABLE missing_flow_revisions
-- statement-breakpoint
DROP TABLE snapshot_agents
-- statement-breakpoint
DROP TABLE snapshot_flows
-- statement-breakpoint
CREATE TRIGGER immutable_run_agent_revision_update BEFORE UPDATE ON run_agent_revisions BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_agent_revision_delete BEFORE DELETE ON run_agent_revisions BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_flow_revision BEFORE UPDATE OF flow_revision_id ON runs
WHEN OLD.flow_revision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_activation_agent_revision BEFORE UPDATE OF agent_revision_id ON run_activations
WHEN OLD.agent_revision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END

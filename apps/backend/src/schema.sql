-- Generated current-schema snapshot. Do not edit by hand.
-- Regenerate: pnpm --filter @t3-factory/backend schema:update
-- Newest applied migration: run_title_launch

CREATE TABLE "activation_messages" (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  request_key TEXT NOT NULL UNIQUE,
  input_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned' CHECK(state='planned')
, accepted_json TEXT);

CREATE TABLE agent_revision_exits (
  agent_revision_id TEXT NOT NULL REFERENCES agent_revisions(id),
  exit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description TEXT NOT NULL,
  message_required INTEGER NOT NULL CHECK (message_required IN (0, 1)),
  PRIMARY KEY (agent_revision_id, exit_id),
  UNIQUE (agent_revision_id, ordinal)
);

CREATE TRIGGER immutable_agent_revision_exit_delete BEFORE DELETE ON agent_revision_exits BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END;

CREATE TRIGGER immutable_agent_revision_exit_update BEFORE UPDATE ON agent_revision_exits BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END;

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
);

CREATE UNIQUE INDEX agent_revisions_identity ON agent_revisions(agent_id, id)
;

CREATE TRIGGER immutable_agent_revision_delete BEFORE DELETE ON agent_revisions BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END;

CREATE TRIGGER immutable_agent_revision_update BEFORE UPDATE ON agent_revisions BEGIN SELECT RAISE(ABORT, 'Agent revisions are immutable'); END;

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL, removed_at TEXT);

CREATE TRIGGER retained_agent_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'Agents are removed, not deleted'); END;

CREATE TABLE appearance_snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  endpoint TEXT NOT NULL,
  presentation TEXT NOT NULL
);

CREATE TABLE client_grants (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'browser')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  secret_hash TEXT NOT NULL,
  verification_code TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  last_seen_at TEXT
);

CREATE INDEX client_grants_status ON client_grants(status, requested_at)
;

CREATE TABLE continuation_visits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'pass-through')),
  source_block_id TEXT,
  binding_id TEXT REFERENCES run_thread_bindings(id),
  activation_id TEXT UNIQUE REFERENCES run_activations(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'sent', 'forwarded', 'cancelled')),
  arrived_at TEXT NOT NULL,
  forwarded_at TEXT,
  CHECK ((kind = 'prompt') = (activation_id IS NOT NULL)),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
);

CREATE UNIQUE INDEX one_prompt_per_continuation ON continuation_visits(run_id, block_id) WHERE kind = 'prompt'
;

CREATE TABLE coordinator_question_replies (
  attention_id TEXT PRIMARY KEY REFERENCES run_attention(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  request_id TEXT NOT NULL,
  message TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  binding_id TEXT NOT NULL REFERENCES run_thread_bindings(id),
  UNIQUE(run_id,request_id)
);

CREATE TRIGGER immutable_coordinator_answer BEFORE UPDATE ON coordinator_question_replies
BEGIN SELECT RAISE(ABORT,'Coordinator answer is immutable'); END;

CREATE TABLE "effect_sql_migrations" (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE factory_server (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL
);

CREATE TABLE "flow_revision_blocks" (
  flow_revision_id TEXT NOT NULL REFERENCES flow_revisions(id),
  block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'continuation', 'wait')),
  name TEXT NOT NULL,
  -- Unresolved by design: drafts may name a missing Agent, and history outlives the Agent.
  agent_id TEXT CHECK (kind = 'agent' OR agent_id IS NULL),
  -- The prompt a Continuation sends once per Run; empty only in a draft.
  prompt TEXT CHECK ((kind = 'continuation') = (prompt IS NOT NULL)),
  x REAL NOT NULL,
  y REAL NOT NULL,
  -- A Wait's duration; both are null while the draft has none. Any finite amount saves:
  -- readiness owns the range, judged on the normalized duration.
  wait_amount REAL,
  wait_unit TEXT CHECK (wait_unit IS NULL OR wait_unit IN ('minutes', 'hours', 'days')),
  CHECK ((wait_amount IS NULL) = (wait_unit IS NULL)),
  CHECK (kind = 'wait' OR wait_amount IS NULL),
  PRIMARY KEY (flow_revision_id, block_id),
  UNIQUE (flow_revision_id, ordinal)
);

CREATE TRIGGER immutable_flow_revision_block_delete BEFORE DELETE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TRIGGER immutable_flow_revision_block_update BEFORE UPDATE ON flow_revision_blocks BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TABLE "flow_revision_connections" (
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
);

CREATE TRIGGER immutable_flow_revision_connection_delete BEFORE DELETE ON flow_revision_connections BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TRIGGER immutable_flow_revision_connection_update BEFORE UPDATE ON flow_revision_connections BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TABLE flow_revision_exits (
  flow_revision_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  exit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  message_required INTEGER NOT NULL CHECK (message_required IN (0, 1)),
  PRIMARY KEY (flow_revision_id, block_id, exit_id),
  UNIQUE (flow_revision_id, block_id, ordinal),
  FOREIGN KEY (flow_revision_id, block_id) REFERENCES flow_revision_blocks(flow_revision_id, block_id)
);

CREATE TRIGGER immutable_flow_revision_exit_delete BEFORE DELETE ON flow_revision_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TRIGGER immutable_flow_revision_exit_update BEFORE UPDATE ON flow_revision_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TABLE flow_revision_hidden_exits (
  flow_revision_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  exit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (flow_revision_id, block_id, exit_id),
  UNIQUE (flow_revision_id, block_id, ordinal),
  FOREIGN KEY (flow_revision_id, block_id) REFERENCES flow_revision_blocks(flow_revision_id, block_id)
);

CREATE TRIGGER immutable_flow_revision_hidden_exit_delete BEFORE DELETE ON flow_revision_hidden_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TRIGGER immutable_flow_revision_hidden_exit_update BEFORE UPDATE ON flow_revision_hidden_exits BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TABLE flow_revision_input_targets (
  flow_revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  block_id TEXT NOT NULL,
  PRIMARY KEY (flow_revision_id, ordinal),
  UNIQUE (flow_revision_id, block_id),
  FOREIGN KEY (flow_revision_id, block_id) REFERENCES flow_revision_blocks(flow_revision_id, block_id)
);

CREATE TRIGGER immutable_flow_revision_input_target_delete BEFORE DELETE ON flow_revision_input_targets BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TRIGGER immutable_flow_revision_input_target_update BEFORE UPDATE ON flow_revision_input_targets BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TABLE flow_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  flow_id TEXT NOT NULL REFERENCES flows(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  input_x REAL NOT NULL,
  input_y REAL NOT NULL,
  saved_at TEXT NOT NULL, workspace_mode TEXT NOT NULL DEFAULT 'checkout'
  CHECK (workspace_mode IN ('checkout', 'worktree')), workspace_base_ref TEXT
  CHECK (workspace_base_ref IS NULL
    OR (workspace_mode = 'worktree' AND length(workspace_base_ref) BETWEEN 1 AND 255)),
  UNIQUE (flow_id, revision)
);

CREATE TRIGGER immutable_flow_revision_delete BEFORE DELETE ON flow_revisions BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TRIGGER immutable_flow_revision_update BEFORE UPDATE ON flow_revisions BEGIN SELECT RAISE(ABORT, 'Flow revisions are immutable'); END;

CREATE TABLE flows (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL, removed_at TEXT);

CREATE INDEX flows_listing ON flows (created_at DESC, id ASC);

CREATE TRIGGER retained_flow_delete BEFORE DELETE ON flows BEGIN SELECT RAISE(ABORT, 'Flows are removed, not deleted'); END;

CREATE TABLE human_occurrences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','withdrawn','cancelled')),
  pending_context TEXT,
  appeared_at TEXT NOT NULL,
  settled_at TEXT,
  exit_id TEXT,
  answer_fingerprint TEXT,
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE TABLE operation_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cause TEXT NOT NULL,
  target_json TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  payload_json TEXT,
  fingerprint TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES t3_authorization_contexts(id),
  retry_scope TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','uncertain','acknowledged','cancelled')),
  reserved_by TEXT,
  reserved_at TEXT,
  result_json TEXT,
  problem TEXT,
  reconciled_at TEXT, report_id TEXT REFERENCES runtime_reports(id), source_block_id TEXT, exit_id TEXT, occurrence_id TEXT REFERENCES human_occurrences(id), recovery_attempt INTEGER NOT NULL DEFAULT 0, recovery_not_before TEXT, binding_id TEXT REFERENCES run_thread_bindings(id), wait_arrival_id TEXT REFERENCES wait_arrivals(id), origin_activation_id TEXT REFERENCES run_activations(id),
  UNIQUE(run_id,cause),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE UNIQUE INDEX one_reservation_per_run ON operation_intents(run_id) WHERE state='reserved'
;

CREATE TABLE project_selection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT REFERENCES projects(id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  availability TEXT NOT NULL,
  observed_at TEXT NOT NULL, project_icon_json TEXT, favicon_path TEXT,
  UNIQUE(endpoint, environment_id, project_id)
);

CREATE TABLE "repeated_visits" (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  original_activation_id TEXT NOT NULL REFERENCES run_activations(id));

CREATE TABLE "report_recoveries" (
  intent_id TEXT PRIMARY KEY REFERENCES operation_intents(id),
  attention_id TEXT UNIQUE REFERENCES run_attention(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  settled_at TEXT,
  thread_scope TEXT,
  FOREIGN KEY(run_id,thread_scope,source_execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
);

CREATE TABLE result_releases (
  report_id TEXT PRIMARY KEY REFERENCES runtime_reports(id),
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  generation INTEGER NOT NULL,
  context_id TEXT NOT NULL,
  released_at TEXT NOT NULL
);

CREATE INDEX result_releases_activation ON result_releases(activation_id)
;

CREATE TABLE run_activations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'delegating' CHECK(phase IN ('delegating','waiting-worker','assessing','reported','finished')),
  created_at TEXT NOT NULL,
  problem TEXT,
  agent_revision_id TEXT NOT NULL REFERENCES agent_revisions(id),
  UNIQUE(run_id,cause),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE TRIGGER immutable_activation_agent_revision BEFORE UPDATE OF agent_revision_id ON run_activations
BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END;

CREATE TABLE run_agent_revisions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_id),
  FOREIGN KEY (agent_id, agent_revision_id) REFERENCES agent_revisions(agent_id, id)
);

CREATE TRIGGER immutable_run_agent_revision_delete BEFORE DELETE ON run_agent_revisions BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END;

CREATE TRIGGER immutable_run_agent_revision_update BEFORE UPDATE ON run_agent_revisions BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END;

CREATE TABLE run_attention (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  native_request_id TEXT,
  occurrence_id TEXT,
  appeared_at TEXT NOT NULL,
  settled_at TEXT,
  settlement_reason TEXT, message TEXT, binding_id TEXT REFERENCES run_thread_bindings(id),
  UNIQUE(run_id,source_key),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE TRIGGER wake_run_on_new_attention AFTER INSERT ON run_attention
WHEN NEW.settled_at IS NULL
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=1
  WHERE run_id=NEW.run_id AND snoozed=1
    AND NOT EXISTS(SELECT 1 FROM run_snooze_attention WHERE run_id=NEW.run_id AND attention_id=NEW.id);
END;

CREATE TABLE run_blocks (
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'not-started',
  thread_id TEXT,
  execution_id TEXT,
  link TEXT,
  engine_status TEXT,
  report_status TEXT,
  pending_request_count INTEGER,
  observed_at TEXT,
  freshness TEXT NOT NULL DEFAULT 'unknown', problem TEXT, public_id TEXT,
  PRIMARY KEY(run_id,block_id),
  UNIQUE(run_id,thread_id)
);

CREATE UNIQUE INDEX run_blocks_public_id ON run_blocks(public_id)
;

CREATE TRIGGER wake_run_on_increased_native_attention AFTER UPDATE OF pending_request_count ON run_blocks
WHEN NEW.pending_request_count > OLD.pending_request_count
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=1
  WHERE run_id=NEW.run_id AND snoozed=1
    AND EXISTS(SELECT 1 FROM run_attention WHERE run_id=NEW.run_id AND block_id=NEW.block_id
      AND kind='native-request' AND settled_at IS NULL);
END;

CREATE TABLE run_closures (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('finished','stopped')),
  generation INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  frontier_json TEXT NOT NULL
, root_frontier_json TEXT);

CREATE TRIGGER immutable_run_closure_delete BEFORE DELETE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END;

CREATE TRIGGER immutable_run_closure_update BEFORE UPDATE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END;

CREATE TABLE run_control_recoveries (
 run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
 source_execution_id TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 activation_id TEXT REFERENCES run_coordinator_commands(activation_id),
 request_key TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL,
 retry_scope TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','uncertain','acknowledged')),
 acknowledgement_json TEXT,
 completed_execution_id TEXT,
 PRIMARY KEY(run_id,source_execution_id)
);

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
  intent_id TEXT REFERENCES operation_intents(id), cancelled_at TEXT);

CREATE TABLE run_coordinators (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  selection_json TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  payload_json TEXT,
  fingerprint TEXT NOT NULL,
  retry_scope TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','uncertain','acknowledged','cancelled')),
  reserved_by TEXT,
  reserved_at TEXT,
  thread_id TEXT UNIQUE,
  execution_id TEXT,
  link TEXT,
  engine_status TEXT,
  problem TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
, instruction_version INTEGER NOT NULL DEFAULT 0 CHECK(instruction_version IN (0,1)), freshness TEXT NOT NULL DEFAULT 'unknown', observed_at TEXT, pending_request_count INTEGER, queued_count INTEGER);

CREATE TABLE run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  observed_at TEXT NOT NULL, execution_id TEXT, cause_id TEXT, source_at TEXT, engine_status TEXT, binding_id TEXT REFERENCES run_thread_bindings(id),
  UNIQUE(run_id,source_key)
);

CREATE INDEX run_activity_by_run ON run_events(run_id, observed_at DESC)
WHERE kind IN ('execution-observed','report-accepted','working-reported','human-answered','attention-appeared','handoff-released','continuation-passed','run-settled','run-activated')
;

CREATE TABLE "run_executions" (
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  engine_status TEXT,
  report_status TEXT,
  observed_at TEXT, ordinal INTEGER, source_at TEXT, problem TEXT, native_request_count INTEGER, binding_id TEXT REFERENCES run_thread_bindings(id), activation_id TEXT REFERENCES run_activations(id),
  PRIMARY KEY(run_id,thread_id,execution_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE TRIGGER immutable_execution_identity BEFORE UPDATE OF run_id,block_id,thread_id,execution_id ON run_executions
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.block_id IS NOT OLD.block_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.execution_id IS NOT OLD.execution_id
BEGIN SELECT RAISE(ABORT, 'Execution identity is immutable'); END;

CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

CREATE TABLE run_images (
  run_id TEXT NOT NULL REFERENCES runs(id),
  image_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  sha256 TEXT NOT NULL REFERENCES staged_images(sha256),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, image_id),
  UNIQUE (run_id, sha256)
);

CREATE INDEX run_images_sha256 ON run_images(sha256)
;

CREATE TRIGGER immutable_run_images_delete BEFORE DELETE ON run_images BEGIN SELECT RAISE(ABORT, 'Run images are immutable'); END;

CREATE TRIGGER immutable_run_images_update BEFORE UPDATE ON run_images BEGIN SELECT RAISE(ABORT, 'Run images are immutable'); END;

CREATE TABLE run_presentation (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  snoozed INTEGER NOT NULL DEFAULT 0 CHECK(snoozed IN (0,1)),
  woke INTEGER NOT NULL DEFAULT 0 CHECK(woke IN (0,1)),
  CHECK(NOT (snoozed=1 AND woke=1))
);

CREATE TABLE run_root_cancelled_controls (
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  source_execution_id TEXT NOT NULL,
  PRIMARY KEY(run_id,source_execution_id)
);

CREATE TABLE run_root_obligations (
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('member','execution','native','remote','command','followup')),
  reference TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,kind,reference)
);

CREATE TABLE "run_root_stop_intents" (
  run_id TEXT NOT NULL REFERENCES runs(id),
  cause TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','reserved','uncertain','acknowledged')),
  PRIMARY KEY(run_id,cause)
);

CREATE TABLE run_settlement_workers (
  run_id TEXT NOT NULL REFERENCES run_settlements(run_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  thread_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('stopping', 'finished', 'unresolved')),
  problem TEXT,
  stop_key TEXT UNIQUE,
  stop_requested_at TEXT,
  stop_outcome TEXT CHECK (stop_outcome IN ('acknowledged', 'failed', 'unsupported')),
  stop_problem TEXT,
  PRIMARY KEY (run_id, attempt, thread_id),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
);

CREATE TABLE run_settlements (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  requested_at TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  attempt_owner TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  stop_pass_at TEXT
);

CREATE TABLE run_snooze_attention (
  run_id TEXT NOT NULL REFERENCES run_presentation(run_id),
  attention_id TEXT NOT NULL REFERENCES run_attention(id),
  PRIMARY KEY(run_id,attention_id)
);

CREATE TABLE "run_thread_bindings" (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('direct-worker','coordinator','worker','descendant')),
  parent_binding_id TEXT REFERENCES run_thread_bindings(id), link TEXT,
  UNIQUE(run_id,environment_id,thread_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE TABLE run_title_generations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'dropped', 'timed-out', 'cancelled', 'skipped', 'failed')),
  reason TEXT,
  provider_instance_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_options_json TEXT NOT NULL,
  model_label TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  deadline_at TEXT NOT NULL,
  automatic_title TEXT NOT NULL,
  generated_title TEXT,
  thread_link TEXT,
  created_at TEXT NOT NULL
, launch_payload_json TEXT, launch_sent_at TEXT, thread_id TEXT);

CREATE TABLE run_title_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  provider_instance_id TEXT,
  model_id TEXT,
  model_options_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  diagnostic_run_id TEXT REFERENCES runs(id),
  diagnostic_message TEXT,
  diagnostic_at TEXT,
  CHECK ((model_id IS NULL) = (provider_instance_id IS NULL)),
  CHECK ((model_id IS NULL) = (model_options_json IS NULL)),
  CHECK (enabled = 0 OR model_id IS NOT NULL),
  CHECK ((diagnostic_run_id IS NULL) = (diagnostic_message IS NULL)),
  CHECK ((diagnostic_run_id IS NULL) = (diagnostic_at IS NULL))
);

CREATE TABLE run_workspaces (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  base_ref TEXT NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  planned_branch TEXT NOT NULL CHECK (length(planned_branch) > 0),
  creator_block_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing', 'bound', 'failed')),
  worktree_path TEXT,
  branch TEXT,
  bound_at TEXT,
  FOREIGN KEY (run_id, creator_block_id) REFERENCES run_blocks(run_id, block_id),
  CHECK ((state = 'bound') = (worktree_path IS NOT NULL AND branch IS NOT NULL AND bound_at IS NOT NULL))
);

CREATE TABLE runner_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  input TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES t3_authorization_contexts(id),
  workspace_root TEXT NOT NULL,
  gate_open INTEGER NOT NULL DEFAULT 1 CHECK(gate_open IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  number INTEGER,
  created_at TEXT NOT NULL DEFAULT '',
  creation_key TEXT NOT NULL DEFAULT '',
  flow_revision_id TEXT NOT NULL REFERENCES flow_revisions(id)
, settled_at TEXT, archived_at TEXT, block_settlement_enabled INTEGER NOT NULL DEFAULT 0 CHECK(block_settlement_enabled IN (0,1)), prompt_segments_json TEXT, title_provenance TEXT NOT NULL DEFAULT 'legacy'
  CHECK (title_provenance IN ('automatic', 'manual', 'generated', 'legacy')));

CREATE UNIQUE INDEX runs_number_unique ON runs(number) WHERE number IS NOT NULL
;

CREATE TRIGGER immutable_run_flow_revision BEFORE UPDATE OF flow_revision_id ON runs
BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END;

CREATE TRIGGER immutable_run_prompt_segments BEFORE UPDATE OF prompt_segments_json ON runs
WHEN OLD.prompt_segments_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Run prompt segments are immutable'); END;

CREATE TABLE runtime_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  execution_id TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting','finished')),
  exit_id TEXT,
  recipients_json TEXT NOT NULL,
  pending_message TEXT,
  acknowledgement_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  completion_eligible_at TEXT,
  activation_id TEXT REFERENCES run_activations(id),
  result_message TEXT,
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE INDEX runtime_reports_activation ON runtime_reports(activation_id)
;

CREATE TRIGGER immutable_activation_report BEFORE UPDATE OF activation_id,result_message,execution_id,fingerprint,status,exit_id,acknowledgement_json ON runtime_reports
WHEN OLD.activation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Activation results are immutable'); END;

CREATE TABLE staged_images (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  staged_at TEXT NOT NULL
);

CREATE TABLE t3_authorization_contexts (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  authorization_identity TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE t3_connection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  endpoint TEXT NOT NULL,
  context_id TEXT REFERENCES t3_authorization_contexts(id)
);

CREATE TABLE "t3_thread_settlements" (
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,execution_id),
  FOREIGN KEY(run_id,thread_id,execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE wait_arrivals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  incoming_intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'forwarded', 'cancelled')),
  forwarded_by TEXT CHECK (forwarded_by IN ('timer', 'user')),
  message TEXT,
  binding_id TEXT REFERENCES run_thread_bindings(id),
  origin_activation_id TEXT REFERENCES run_activations(id),
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((state = 'forwarded') = (forwarded_by IS NOT NULL)),
  CHECK ((state = 'pending') = (settled_at IS NULL)),
  CHECK (origin_activation_id IS NULL OR binding_id IS NOT NULL),
  FOREIGN KEY (run_id, block_id) REFERENCES run_blocks(run_id, block_id)
);

CREATE INDEX wait_arrivals_pending ON wait_arrivals(deadline_at) WHERE state = 'pending'
;

CREATE TABLE worker_pull_requests (
  binding_id TEXT NOT NULL REFERENCES worker_repositories(binding_id),
  host TEXT NOT NULL,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  url TEXT NOT NULL,
  state TEXT CHECK (state IN ('open', 'closed', 'merged')),
  PRIMARY KEY (binding_id, host, repository, number)
);

CREATE TABLE worker_repositories (
  binding_id TEXT PRIMARY KEY NOT NULL REFERENCES run_thread_bindings(id),
  branch TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE "working_reports" (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  execution_id TEXT,
  fingerprint TEXT NOT NULL,
  message TEXT NOT NULL,
  acknowledgement_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  replaced_at TEXT,
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);

CREATE UNIQUE INDEX one_current_working_report ON working_reports(activation_id) WHERE replaced_at IS NULL
;

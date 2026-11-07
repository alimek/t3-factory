-- Factory launches each Block worker itself. Open Runs captured under the replaced
-- Run-conversation contract are deleted. Closed Runs stay as read-only history.
-- Tasks, projects, Flows, Agents and client access are kept.
-- Stop intents belong to the Run, including a Run that has no coordinator row.
ALTER TABLE operation_intents ADD COLUMN recovery_attempt INTEGER NOT NULL DEFAULT 0
-- statement-breakpoint
ALTER TABLE operation_intents ADD COLUMN recovery_not_before TEXT
-- statement-breakpoint
ALTER TABLE runs ADD COLUMN number INTEGER
-- statement-breakpoint
CREATE UNIQUE INDEX runs_number_unique ON runs(number) WHERE number IS NOT NULL
-- statement-breakpoint
DROP TRIGGER immutable_run_snapshot_update
-- statement-breakpoint
DROP TRIGGER immutable_run_snapshot_delete
-- statement-breakpoint
DROP TRIGGER immutable_run_closure_delete
-- statement-breakpoint
DROP TRIGGER immutable_assessment_checkpoint_delete
-- statement-breakpoint
DROP TRIGGER run_worker_activations_immutable_delete
-- statement-breakpoint
DROP TRIGGER immutable_execution_membership
-- statement-breakpoint
CREATE TEMP TABLE open_runs AS SELECT id FROM runs WHERE closed_at IS NULL
-- statement-breakpoint
CREATE TEMP TABLE open_activations AS
  SELECT id FROM run_activations WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
UPDATE operation_intents SET occurrence_id = NULL, report_id = NULL
WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
UPDATE run_coordinator_commands SET intent_id = NULL WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
UPDATE run_thread_bindings SET parent_binding_id = NULL WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_snooze_attention WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_question_replies WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_waits WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM coordinator_native_items WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM coordinator_remote_work WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM coordinator_releases WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM assessment_checkpoints WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM coordinator_revisits WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM run_worker_activations WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM run_control_recoveries WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_native_human_replies WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_native_commands WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_local_executions WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_peer_obligations WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_native_obligations WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM coordinator_settlements WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_root_settlements WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_root_stop_intents WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_root_obligations WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_root_cancelled_controls WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_coordinator_obligations WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM report_recoveries WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM human_occurrences WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_coordinator_commands WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM operation_intents WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_attention WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM runtime_reports WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_events WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_executions WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_delegations WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM run_thread_bindings WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_activations WHERE id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM run_closures WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_presentation WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_coordinators WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_snapshots WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_blocks WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM runs WHERE id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DROP TABLE open_activations
-- statement-breakpoint
DROP TABLE open_runs
-- statement-breakpoint
UPDATE runs SET number = (
  SELECT COUNT(*) FROM runs AS older
  WHERE older.started_at < runs.started_at
     OR (older.started_at = runs.started_at AND older.id <= runs.id))
-- statement-breakpoint
UPDATE run_snapshots SET snapshot_json = json_remove(
  snapshot_json,
  '$.executionContract',
  '$.coordinationInstructionVersion',
  '$.reportingProtocol',
  '$.flow.coordinator',
  '$.flow.coordinatorStatus')
-- statement-breakpoint
ALTER TABLE flows DROP COLUMN coordinator_json
-- statement-breakpoint
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
CREATE TABLE run_root_stop_intents_next (
  run_id TEXT NOT NULL REFERENCES runs(id),
  cause TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','reserved','uncertain','acknowledged')),
  PRIMARY KEY(run_id,cause)
)
-- statement-breakpoint
INSERT INTO run_root_stop_intents_next(run_id,cause,thread_id,payload_json,state)
SELECT run_id,cause,thread_id,payload_json,state FROM run_root_stop_intents
WHERE run_id IN (SELECT id FROM runs)
-- statement-breakpoint
DROP TABLE run_root_stop_intents
-- statement-breakpoint
ALTER TABLE run_root_stop_intents_next RENAME TO run_root_stop_intents
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_update BEFORE UPDATE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_delete BEFORE DELETE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_run_closure_delete BEFORE DELETE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_assessment_checkpoint_delete BEFORE DELETE ON assessment_checkpoints BEGIN SELECT RAISE(ABORT,'Assessment checkpoints are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER run_worker_activations_immutable_delete BEFORE DELETE ON run_worker_activations BEGIN SELECT RAISE(ABORT, 'Worker activation authority is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
AND NOT (OLD.binding_id=NEW.binding_id AND OLD.activation_id IS NULL AND EXISTS(SELECT 1 FROM run_worker_activations w JOIN coordinator_native_human_replies h ON h.run_id=NEW.run_id AND h.thread_id=NEW.thread_id AND h.execution_id=NEW.execution_id JOIN coordinator_waits q ON q.activation_id=w.activation_id JOIN run_attention a ON a.id=q.attention_id JOIN run_executions prior ON prior.binding_id=q.target_binding_id AND prior.execution_id=q.target_execution_id WHERE w.activation_id=NEW.activation_id AND w.binding_id=NEW.binding_id AND a.settled_at IS NULL AND prior.ordinal<NEW.ordinal))
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

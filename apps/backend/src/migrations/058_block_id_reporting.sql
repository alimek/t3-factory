-- Agents report by naming their Block id instead of having Factory correlate native tool
-- calls with exact worker executions. Open Runs captured under per-turn report authority are
-- deleted (accepted by the user); closed Runs, Runs awaiting Stop confirmation,
-- Tasks that still hold a Run, Projects, Flows,
-- Agents, client access and the T3 connection are kept. Storage that existed only for
-- per-turn authority is dropped: assessment checkpoints, native reply and continuation
-- provenance, report keys and the execution-scoped report uniqueness.
PRAGMA defer_foreign_keys=ON
-- statement-breakpoint
DROP TABLE assessment_checkpoints
-- statement-breakpoint
DROP TRIGGER immutable_execution_membership
-- statement-breakpoint
DROP TABLE coordinator_native_human_replies
-- statement-breakpoint
DROP TABLE worker_native_continuations
-- statement-breakpoint
DROP TRIGGER immutable_run_closure_delete
-- statement-breakpoint
DROP TRIGGER run_worker_activations_immutable_delete
-- statement-breakpoint
DROP TRIGGER immutable_run_agent_revision_delete
-- statement-breakpoint
CREATE TEMP TABLE open_runs AS SELECT id FROM runs WHERE closed_at IS NULL AND stop_requested_at IS NULL
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
DELETE FROM coordinator_revisits WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM run_worker_activations WHERE activation_id IN (SELECT id FROM open_activations)
-- statement-breakpoint
DELETE FROM run_control_recoveries WHERE run_id IN (SELECT id FROM open_runs)
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
DELETE FROM run_agent_revisions WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM run_blocks WHERE run_id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM runs WHERE id IN (SELECT id FROM open_runs)
-- statement-breakpoint
DELETE FROM tasks WHERE id NOT IN (SELECT task_id FROM runs)
-- statement-breakpoint
DROP TABLE open_activations
-- statement-breakpoint
DROP TABLE open_runs
-- statement-breakpoint
CREATE TEMP TABLE runtime_reports_saved AS SELECT * FROM runtime_reports
-- statement-breakpoint
DROP TABLE runtime_reports
-- statement-breakpoint
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
)
-- statement-breakpoint
INSERT INTO runtime_reports (
  id, run_id, block_id, execution_id, fingerprint, status, exit_id, recipients_json,
  pending_message, acknowledgement_json, accepted_at, completion_eligible_at, activation_id,
  result_message
)
SELECT
  id, run_id, block_id, execution_id, fingerprint, status, exit_id, recipients_json,
  pending_message, acknowledgement_json, accepted_at, completion_eligible_at, activation_id,
  result_message
FROM runtime_reports_saved ORDER BY rowid
-- statement-breakpoint
DROP TABLE runtime_reports_saved
-- statement-breakpoint
CREATE UNIQUE INDEX one_activation_result ON runtime_reports(activation_id) WHERE activation_id IS NOT NULL
-- statement-breakpoint
CREATE TRIGGER immutable_activation_report BEFORE UPDATE OF activation_id,result_message,execution_id,fingerprint,status,exit_id,acknowledgement_json ON runtime_reports
WHEN OLD.activation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Activation results are immutable'); END
-- statement-breakpoint
CREATE TEMP TABLE coordinator_waits_saved AS SELECT * FROM coordinator_waits
-- statement-breakpoint
DROP TABLE coordinator_waits
-- statement-breakpoint
CREATE TABLE coordinator_waits (
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  fingerprint TEXT NOT NULL,
  acknowledgement_json TEXT NOT NULL,
  target_binding_id TEXT REFERENCES run_thread_bindings(id),
  target_execution_id TEXT,
  attention_id TEXT NOT NULL REFERENCES run_attention(id)
)
-- statement-breakpoint
INSERT INTO coordinator_waits (
  id, activation_id, fingerprint, acknowledgement_json, target_binding_id, target_execution_id,
  attention_id
)
SELECT
  id, activation_id, fingerprint, acknowledgement_json, target_binding_id, target_execution_id,
  attention_id
FROM coordinator_waits_saved ORDER BY rowid
-- statement-breakpoint
DROP TABLE coordinator_waits_saved
-- statement-breakpoint
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_closure_delete BEFORE DELETE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END
-- statement-breakpoint
CREATE TRIGGER run_worker_activations_immutable_delete BEFORE DELETE ON run_worker_activations BEGIN SELECT RAISE(ABORT, 'Worker activation authority is immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_agent_revision_delete BEFORE DELETE ON run_agent_revisions BEGIN SELECT RAISE(ABORT, 'Run definition revisions are immutable'); END
-- statement-breakpoint
ALTER TABLE run_blocks ADD COLUMN public_id TEXT
-- statement-breakpoint
CREATE UNIQUE INDEX run_blocks_public_id ON run_blocks(public_id)

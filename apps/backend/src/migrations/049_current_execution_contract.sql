-- Factory keeps one execution contract: run-worker-v1 with explicit-mcp-v2 reporting and
-- coordination instruction version 5. Runs captured under direct-worker-v1,
-- coordinator-child-v1 or run-coordinator-v1, or under the structured-message-v1,
-- runtime-mcp-v1 or explicit-mcp-v1 reporting protocols, are deleted with every row
-- they own. Tasks, projects, Flows, Agents and client access are kept.
CREATE TEMP TABLE legacy_runs AS SELECT id FROM runs WHERE id NOT IN (
  SELECT run_id FROM run_snapshots
  WHERE json_extract(snapshot_json, '$.executionContract') = 'run-worker-v1'
    AND json_extract(snapshot_json, '$.reportingProtocol') = 'explicit-mcp-v2'
    AND json_extract(snapshot_json, '$.coordinationInstructionVersion') = 5)
-- statement-breakpoint
CREATE TEMP TABLE legacy_activations AS
  SELECT id FROM run_activations WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
-- Tables used only by the removed contracts and the legacy runtime MCP setup.
DROP TABLE report_items
-- statement-breakpoint
DROP TABLE runtime_proposals
-- statement-breakpoint
DROP TABLE thread_settlements
-- statement-breakpoint
DROP TABLE coordinator_bootstrap_recoveries
-- statement-breakpoint
DROP TABLE coordinator_recoveries
-- statement-breakpoint
DROP TABLE coordinator_stop_requests
-- statement-breakpoint
DROP TABLE coordinator_task_results
-- statement-breakpoint
-- Removed-contract triggers: legacy binding roles and Block coordinator context grants.
DROP TRIGGER bind_run_execution
-- statement-breakpoint
DROP TRIGGER immutable_context_grant
-- statement-breakpoint
DROP TRIGGER immutable_execution_membership
-- statement-breakpoint
-- Immutable history is lifted only to delete removed-contract Runs and rewrite Agent shapes;
-- every trigger is recreated unchanged below.
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
-- Break reference cycles inside the deleted Runs before deleting children first.
UPDATE operation_intents SET occurrence_id = NULL, report_id = NULL
WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
UPDATE run_coordinator_commands SET intent_id = NULL WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
UPDATE run_thread_bindings SET parent_binding_id = NULL WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_snooze_attention WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_question_replies WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_waits WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM coordinator_native_items WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM coordinator_remote_work WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM coordinator_releases WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM assessment_checkpoints WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM coordinator_revisits WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM run_worker_activations WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM run_control_recoveries WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_native_human_replies WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_native_commands WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_local_executions WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_peer_obligations WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_native_obligations WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM coordinator_settlements WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_root_settlements WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_root_stop_intents WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_root_obligations WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_root_cancelled_controls WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_coordinator_obligations WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM report_recoveries WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM human_occurrences WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_coordinator_commands WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM operation_intents WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_attention WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM runtime_reports WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_events WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_executions WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_delegations WHERE activation_id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM run_thread_bindings WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_activations WHERE id IN (SELECT id FROM legacy_activations)
-- statement-breakpoint
DELETE FROM run_closures WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_presentation WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_coordinators WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_snapshots WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM run_blocks WHERE run_id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DELETE FROM runs WHERE id IN (SELECT id FROM legacy_runs)
-- statement-breakpoint
DROP TABLE legacy_activations
-- statement-breakpoint
DROP TABLE legacy_runs
-- statement-breakpoint
-- Columns used only by the removed contracts: Agent Block coordinator settings, Block
-- coordinator context grants, revisit receipts and coordinator assessment context.
ALTER TABLE agents DROP COLUMN coordinator_json
-- statement-breakpoint
ALTER TABLE run_coordinator_commands DROP COLUMN context_granted
-- statement-breakpoint
ALTER TABLE run_coordinator_commands DROP COLUMN context_call_id
-- statement-breakpoint
ALTER TABLE run_coordinator_commands DROP COLUMN context_reply_json
-- statement-breakpoint
ALTER TABLE run_coordinator_commands DROP COLUMN context_execution_id
-- statement-breakpoint
ALTER TABLE coordinator_revisits DROP COLUMN receipt_json
-- statement-breakpoint
ALTER TABLE run_activations DROP COLUMN task_context
-- statement-breakpoint
-- Captured Agents lose the removed Block coordinator settings; order and every other
-- captured field, including worker settings and revisions, stay unchanged.
UPDATE run_snapshots SET snapshot_json = json_set(snapshot_json, '$.agents', (
  SELECT json_group_array(json(agent)) FROM (
    SELECT json_remove(value, '$.coordinator', '$.coordinatorStatus') AS agent
    FROM json_each(run_snapshots.snapshot_json, '$.agents') ORDER BY key)))
WHERE EXISTS(
  SELECT 1 FROM json_each(run_snapshots.snapshot_json, '$.agents')
  WHERE json_type(value, '$.coordinator') IS NOT NULL
    OR json_type(value, '$.coordinatorStatus') IS NOT NULL)
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
-- A worker execution's membership is fixed once bound. The only exception is a verified
-- native user answer to that worker's pending question joining the question's activation.
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
AND NOT (OLD.binding_id=NEW.binding_id AND OLD.activation_id IS NULL AND EXISTS(SELECT 1 FROM run_worker_activations w JOIN coordinator_native_human_replies h ON h.run_id=NEW.run_id AND h.thread_id=NEW.thread_id AND h.execution_id=NEW.execution_id JOIN coordinator_waits q ON q.activation_id=w.activation_id JOIN run_attention a ON a.id=q.attention_id JOIN run_executions prior ON prior.binding_id=q.target_binding_id AND prior.execution_id=q.target_execution_id WHERE w.activation_id=NEW.activation_id AND w.binding_id=NEW.binding_id AND a.settled_at IS NULL AND prior.ordinal<NEW.ordinal))
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

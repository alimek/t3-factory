DROP TRIGGER immutable_execution_membership;
-- statement-breakpoint
-- A settled question may have further user replies before the activation's final result.
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
AND NOT (
  OLD.binding_id=NEW.binding_id
  AND OLD.activation_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM runtime_reports WHERE activation_id=NEW.activation_id)
  AND EXISTS(
    SELECT 1 FROM run_worker_activations w
    JOIN coordinator_native_human_replies h ON h.run_id=NEW.run_id AND h.thread_id=NEW.thread_id AND h.execution_id=NEW.execution_id
    JOIN coordinator_waits q ON q.activation_id=w.activation_id
    JOIN run_executions prior ON prior.binding_id=q.target_binding_id AND prior.execution_id=q.target_execution_id
    WHERE w.activation_id=NEW.activation_id AND w.binding_id=NEW.binding_id AND prior.ordinal<NEW.ordinal
  )
)
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

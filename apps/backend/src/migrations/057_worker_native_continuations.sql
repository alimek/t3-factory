CREATE TABLE worker_native_continuations (
  run_id TEXT NOT NULL REFERENCES runs(id),
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,execution_id,item_id)
);
-- statement-breakpoint
DROP TRIGGER immutable_execution_membership;
-- statement-breakpoint
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
AND NOT (
  OLD.binding_id=NEW.binding_id
  AND OLD.activation_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM runtime_reports WHERE activation_id=NEW.activation_id)
  AND EXISTS(
    SELECT 1 FROM run_worker_activations w
    WHERE w.activation_id=NEW.activation_id AND w.binding_id=NEW.binding_id
    AND (
      EXISTS(
        SELECT 1 FROM coordinator_native_human_replies h
        JOIN coordinator_waits q ON q.activation_id=w.activation_id
        JOIN run_executions prior ON prior.binding_id=q.target_binding_id AND prior.execution_id=q.target_execution_id
        WHERE h.run_id=NEW.run_id AND h.thread_id=NEW.thread_id AND h.execution_id=NEW.execution_id
        AND prior.ordinal<NEW.ordinal
      )
      OR EXISTS(
        SELECT 1 FROM worker_native_continuations n
        JOIN run_executions prior ON prior.binding_id=NEW.binding_id AND prior.activation_id=w.activation_id
        WHERE n.run_id=NEW.run_id AND n.thread_id=NEW.thread_id AND n.execution_id=NEW.execution_id
        AND prior.ordinal<NEW.ordinal
        AND NOT EXISTS(SELECT 1 FROM coordinator_waits q JOIN run_attention a ON a.id=q.attention_id WHERE q.activation_id=w.activation_id AND a.settled_at IS NULL)
      )
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

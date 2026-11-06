-- Direct native workers retain immutable activation and parent-tree authority.
-- Historical contracts and pending payloads are deliberately unchanged.
CREATE TABLE run_worker_activations (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  binding_id TEXT NOT NULL REFERENCES run_thread_bindings(id),
  initial_execution_id TEXT NOT NULL,
  parent_thread_id TEXT NOT NULL
);
-- statement-breakpoint
CREATE TRIGGER run_worker_activations_immutable_update BEFORE UPDATE ON run_worker_activations BEGIN SELECT RAISE(ABORT, 'Worker activation authority is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER run_worker_activations_immutable_delete BEFORE DELETE ON run_worker_activations BEGIN SELECT RAISE(ABORT, 'Worker activation authority is immutable'); END;
-- statement-breakpoint
DROP TRIGGER immutable_execution_membership;
-- statement-breakpoint
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR
 (NEW.activation_id IS NOT OLD.activation_id AND (OLD.activation_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM coordinator_revisits v JOIN run_activations a ON a.id=v.activation_id
   WHERE v.activation_id=NEW.activation_id AND a.run_id=NEW.run_id AND a.block_id=NEW.block_id AND
   ((json_extract(v.receipt_json,'$.parentRunId')=NEW.execution_id AND EXISTS(SELECT 1 FROM run_thread_bindings b WHERE b.id=NEW.binding_id AND b.role='coordinator')) OR (json_extract(v.receipt_json,'$.threadId')=NEW.thread_id AND json_extract(v.receipt_json,'$.runId')=NEW.execution_id)
    OR EXISTS(SELECT 1 FROM coordinator_task_results t WHERE t.activation_id=v.activation_id AND
      ((t.thread_id=NEW.thread_id AND t.execution_id=NEW.execution_id) OR
       (t.source_execution_id=NEW.execution_id AND EXISTS(SELECT 1 FROM run_thread_bindings b WHERE b.id=NEW.binding_id AND b.role='coordinator')))))
 ))))
AND NOT (OLD.binding_id=NEW.binding_id AND OLD.activation_id IS NULL AND EXISTS(SELECT 1 FROM run_worker_activations w JOIN coordinator_native_human_replies h ON h.run_id=NEW.run_id AND h.thread_id=NEW.thread_id AND h.execution_id=NEW.execution_id JOIN coordinator_waits q ON q.activation_id=w.activation_id JOIN run_attention a ON a.id=q.attention_id JOIN run_executions prior ON prior.binding_id=q.target_binding_id AND prior.execution_id=q.target_execution_id WHERE w.activation_id=NEW.activation_id AND w.binding_id=NEW.binding_id AND a.settled_at IS NULL AND prior.ordinal<NEW.ordinal))
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

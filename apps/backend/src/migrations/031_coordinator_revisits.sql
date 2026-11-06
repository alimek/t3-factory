PRAGMA defer_foreign_keys=ON;
-- statement-breakpoint
DROP TRIGGER bind_run_execution;
-- statement-breakpoint
DROP TRIGGER immutable_execution_membership;
-- statement-breakpoint
CREATE TABLE run_activations_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'delegating' CHECK(phase IN ('delegating','waiting-worker','assessing','reported','finished')),
  coverage TEXT NOT NULL DEFAULT 'unverified' CHECK(coverage IN ('unverified','local-bounded')),
  created_at TEXT NOT NULL,
  evidence_json TEXT,
  problem TEXT,
  UNIQUE(run_id,cause),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);
-- statement-breakpoint
INSERT INTO run_activations_next SELECT * FROM run_activations;
-- statement-breakpoint
DROP TABLE run_activations;
-- statement-breakpoint
ALTER TABLE run_activations_next RENAME TO run_activations;
-- statement-breakpoint
CREATE TRIGGER bind_run_execution AFTER INSERT ON run_executions WHEN NEW.binding_id IS NULL BEGIN
  INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role)
  SELECT lower(hex(randomblob(16))),NEW.run_id,NEW.block_id,c.environment_id,NEW.thread_id,
    CASE json_extract(s.snapshot_json,'$.executionContract') WHEN 'coordinator-child-v1' THEN 'coordinator' ELSE 'direct-worker' END
  FROM runs r JOIN run_snapshots s ON s.run_id=r.id JOIN t3_authorization_contexts c ON c.id=r.context_id WHERE r.id=NEW.run_id
  ON CONFLICT(run_id,environment_id,thread_id) DO NOTHING;
  UPDATE run_executions SET binding_id=(SELECT id FROM run_thread_bindings WHERE run_id=NEW.run_id AND thread_id=NEW.thread_id),
    activation_id=(SELECT a.id FROM run_activations a JOIN operation_intents i ON i.run_id=a.run_id AND i.cause=a.cause
      WHERE a.run_id=NEW.run_id AND a.block_id=NEW.block_id AND i.kind IN ('launch','send') AND i.state='acknowledged'
        AND json_extract(i.result_json,'$.threadId')=NEW.thread_id AND json_extract(i.result_json,'$.runId')=NEW.execution_id)
  WHERE run_id=NEW.run_id AND thread_id=NEW.thread_id AND execution_id=NEW.execution_id;
END;
-- statement-breakpoint
CREATE TABLE coordinator_revisits (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  original_activation_id TEXT NOT NULL REFERENCES run_activations(id),
  receipt_json TEXT
);
-- statement-breakpoint
CREATE TABLE coordinator_task_results_next (
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  task_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(activation_id,task_id,source_execution_id)
);
-- statement-breakpoint
INSERT INTO coordinator_task_results_next SELECT * FROM coordinator_task_results;
-- statement-breakpoint
DROP TABLE coordinator_task_results;
-- statement-breakpoint
ALTER TABLE coordinator_task_results_next RENAME TO coordinator_task_results;
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
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;
-- statement-breakpoint
CREATE TEMP TABLE revisit_foreign_keys(valid INTEGER CHECK(valid=0));
-- statement-breakpoint
INSERT INTO revisit_foreign_keys SELECT count(*) FROM pragma_foreign_key_check;
-- statement-breakpoint
DROP TABLE revisit_foreign_keys;
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF;

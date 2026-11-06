-- Rewrite only the execution contract discriminator. Pending operation bytes remain untouched.
DROP TRIGGER immutable_run_snapshot_update;
-- statement-breakpoint
UPDATE run_snapshots SET snapshot_json=json_set(snapshot_json,'$.executionContract','direct-worker-v1','$.coordinationInstructionVersion',NULL);
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_update BEFORE UPDATE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END;
-- statement-breakpoint
CREATE TABLE run_activations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'delegating' CHECK(phase='delegating'),
  coverage TEXT NOT NULL DEFAULT 'unverified' CHECK(coverage='unverified'),
  created_at TEXT NOT NULL,
  UNIQUE(run_id,cause),
  UNIQUE(run_id,block_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);
-- statement-breakpoint
CREATE TABLE run_delegations (
  activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
  request_key TEXT NOT NULL UNIQUE,
  input_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned' CHECK(state='planned')
);
-- statement-breakpoint
CREATE TABLE run_thread_bindings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('direct-worker','coordinator')),
  parent_binding_id TEXT REFERENCES run_thread_bindings(id),
  UNIQUE(run_id,environment_id,thread_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);
-- statement-breakpoint
INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role)
SELECT lower(hex(randomblob(16))), b.run_id,b.block_id,c.environment_id,b.thread_id,'direct-worker'
FROM run_blocks b JOIN runs r ON r.id=b.run_id JOIN t3_authorization_contexts c ON c.id=r.context_id WHERE b.thread_id IS NOT NULL;
-- statement-breakpoint
ALTER TABLE run_executions ADD COLUMN binding_id TEXT REFERENCES run_thread_bindings(id);
-- statement-breakpoint
ALTER TABLE run_executions ADD COLUMN activation_id TEXT REFERENCES run_activations(id);
-- statement-breakpoint
UPDATE run_executions SET binding_id=(SELECT b.id FROM run_thread_bindings b WHERE b.run_id=run_executions.run_id AND b.thread_id=run_executions.thread_id);
-- statement-breakpoint
CREATE TRIGGER bind_run_execution AFTER INSERT ON run_executions BEGIN
  INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role)
  SELECT lower(hex(randomblob(16))),NEW.run_id,NEW.block_id,c.environment_id,NEW.thread_id,
    CASE json_extract(s.snapshot_json,'$.executionContract') WHEN 'coordinator-child-v1' THEN 'coordinator' ELSE 'direct-worker' END
  FROM runs r JOIN run_snapshots s ON s.run_id=r.id JOIN t3_authorization_contexts c ON c.id=r.context_id WHERE r.id=NEW.run_id
  ON CONFLICT(run_id,environment_id,thread_id) DO NOTHING;
  UPDATE run_executions SET binding_id=(SELECT id FROM run_thread_bindings WHERE run_id=NEW.run_id AND thread_id=NEW.thread_id),
    activation_id=(SELECT a.id FROM run_activations a JOIN operation_intents i ON i.run_id=a.run_id AND i.cause=a.cause
      WHERE a.run_id=NEW.run_id AND a.block_id=NEW.block_id AND i.kind='launch' AND i.state='acknowledged'
        AND json_extract(i.result_json,'$.threadId')=NEW.thread_id AND json_extract(i.result_json,'$.runId')=NEW.execution_id)
  WHERE run_id=NEW.run_id AND block_id=NEW.block_id AND execution_id=NEW.execution_id;
END;
-- statement-breakpoint
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;

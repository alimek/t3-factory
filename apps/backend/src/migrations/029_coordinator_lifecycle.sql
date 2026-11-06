PRAGMA defer_foreign_keys=ON;
-- statement-breakpoint
CREATE UNIQUE INDEX migration_execution_scope ON run_executions(run_id,thread_id,execution_id);
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
  UNIQUE(run_id,cause),
  UNIQUE(run_id,block_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);
-- statement-breakpoint
INSERT INTO run_activations_next SELECT * FROM run_activations;
-- statement-breakpoint
DROP TABLE run_activations;
-- statement-breakpoint
ALTER TABLE run_activations_next RENAME TO run_activations;
-- statement-breakpoint
CREATE TABLE run_thread_bindings_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('direct-worker','coordinator','worker','descendant')),
  parent_binding_id TEXT REFERENCES run_thread_bindings(id),
  UNIQUE(run_id,environment_id,thread_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);
-- statement-breakpoint
INSERT INTO run_thread_bindings_next SELECT * FROM run_thread_bindings;
-- statement-breakpoint
DROP TABLE run_thread_bindings;
-- statement-breakpoint
ALTER TABLE run_thread_bindings_next RENAME TO run_thread_bindings;
-- statement-breakpoint
CREATE TABLE runtime_reports_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  report_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting','finished')),
  exit_id TEXT,
  recipients_json TEXT NOT NULL,
  pending_message TEXT,
  acknowledgement_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL, final_contract INTEGER NOT NULL DEFAULT 0, completion_eligible_at TEXT,
  thread_scope TEXT,
  UNIQUE(run_id,block_id,execution_id,report_key),
  FOREIGN KEY(run_id,thread_scope,execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
);
-- statement-breakpoint
INSERT INTO runtime_reports_next SELECT *, (SELECT thread_id FROM run_blocks b WHERE b.run_id=runtime_reports.run_id AND b.block_id=runtime_reports.block_id) FROM runtime_reports;
-- statement-breakpoint
DROP TABLE runtime_reports;
-- statement-breakpoint
ALTER TABLE runtime_reports_next RENAME TO runtime_reports;
-- statement-breakpoint
CREATE TABLE report_recoveries_next (
  attention_id TEXT PRIMARY KEY REFERENCES run_attention(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  block_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  requested_at TEXT NOT NULL,
  settled_at TEXT,
  thread_scope TEXT,
  FOREIGN KEY(run_id,thread_scope,source_execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
);
-- statement-breakpoint
INSERT INTO report_recoveries_next SELECT *, (SELECT thread_id FROM run_blocks b WHERE b.run_id=report_recoveries.run_id AND b.block_id=report_recoveries.block_id) FROM report_recoveries;
-- statement-breakpoint
DROP TABLE report_recoveries;
-- statement-breakpoint
ALTER TABLE report_recoveries_next RENAME TO report_recoveries;
-- statement-breakpoint
CREATE TABLE thread_settlements_next (
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  retired_at TEXT,
  outcome TEXT CHECK(outcome IN ('acknowledged','uncertain')),
  thread_scope TEXT,
  PRIMARY KEY(run_id,block_id,execution_id),
  FOREIGN KEY(run_id,thread_scope,execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
);
-- statement-breakpoint
INSERT INTO thread_settlements_next SELECT *, (SELECT thread_id FROM run_blocks b WHERE b.run_id=thread_settlements.run_id AND b.block_id=thread_settlements.block_id) FROM thread_settlements;
-- statement-breakpoint
DROP TABLE thread_settlements;
-- statement-breakpoint
ALTER TABLE thread_settlements_next RENAME TO thread_settlements;
-- statement-breakpoint
CREATE TABLE run_executions_next (
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
-- statement-breakpoint
INSERT INTO run_executions_next SELECT * FROM run_executions;
-- statement-breakpoint
DROP TABLE run_executions;
-- statement-breakpoint
ALTER TABLE run_executions_next RENAME TO run_executions;
-- statement-breakpoint
CREATE UNIQUE INDEX one_final_result ON runtime_reports(run_id,block_id,execution_id) WHERE final_contract=1;
-- statement-breakpoint
ALTER TABLE runtime_reports ADD COLUMN activation_id TEXT REFERENCES run_activations(id);
-- statement-breakpoint
ALTER TABLE runtime_reports ADD COLUMN result_message TEXT;
-- statement-breakpoint
CREATE UNIQUE INDEX one_activation_result ON runtime_reports(activation_id) WHERE activation_id IS NOT NULL;
-- statement-breakpoint
ALTER TABLE run_activations ADD COLUMN evidence_json TEXT;
-- statement-breakpoint
ALTER TABLE run_activations ADD COLUMN problem TEXT;
-- statement-breakpoint
ALTER TABLE run_delegations ADD COLUMN accepted_json TEXT;
-- statement-breakpoint
CREATE TRIGGER bind_run_execution AFTER INSERT ON run_executions WHEN NEW.binding_id IS NULL BEGIN
  INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role)
  SELECT lower(hex(randomblob(16))),NEW.run_id,NEW.block_id,c.environment_id,NEW.thread_id,
    CASE json_extract(s.snapshot_json,'$.executionContract') WHEN 'coordinator-child-v1' THEN 'coordinator' ELSE 'direct-worker' END
  FROM runs r JOIN run_snapshots s ON s.run_id=r.id JOIN t3_authorization_contexts c ON c.id=r.context_id WHERE r.id=NEW.run_id
  ON CONFLICT(run_id,environment_id,thread_id) DO NOTHING;
  UPDATE run_executions SET binding_id=(SELECT id FROM run_thread_bindings WHERE run_id=NEW.run_id AND thread_id=NEW.thread_id),
    activation_id=(SELECT a.id FROM run_activations a JOIN operation_intents i ON i.run_id=a.run_id AND i.cause=a.cause
      WHERE a.run_id=NEW.run_id AND a.block_id=NEW.block_id AND i.kind='launch' AND i.state='acknowledged'
        AND json_extract(i.result_json,'$.threadId')=NEW.thread_id AND json_extract(i.result_json,'$.runId')=NEW.execution_id)
  WHERE run_id=NEW.run_id AND thread_id=NEW.thread_id AND execution_id=NEW.execution_id;
END;
-- statement-breakpoint
CREATE TRIGGER immutable_execution_membership BEFORE UPDATE OF binding_id,activation_id ON run_executions
WHEN OLD.binding_id IS NOT NULL AND (NEW.binding_id IS NOT OLD.binding_id OR NEW.activation_id IS NOT OLD.activation_id)
BEGIN SELECT RAISE(ABORT, 'Execution membership is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER scope_runtime_reports AFTER INSERT ON runtime_reports WHEN NEW.thread_scope IS NULL BEGIN UPDATE runtime_reports SET thread_scope=(SELECT thread_id FROM run_blocks WHERE run_id=NEW.run_id AND block_id=NEW.block_id) WHERE rowid=NEW.rowid; END;
-- statement-breakpoint
CREATE TRIGGER scope_report_recoveries AFTER INSERT ON report_recoveries WHEN NEW.thread_scope IS NULL BEGIN UPDATE report_recoveries SET thread_scope=(SELECT thread_id FROM run_blocks WHERE run_id=NEW.run_id AND block_id=NEW.block_id) WHERE rowid=NEW.rowid; END;
-- statement-breakpoint
CREATE TRIGGER scope_thread_settlements AFTER INSERT ON thread_settlements WHEN NEW.thread_scope IS NULL BEGIN UPDATE thread_settlements SET thread_scope=(SELECT thread_id FROM run_blocks WHERE run_id=NEW.run_id AND block_id=NEW.block_id) WHERE rowid=NEW.rowid; END;
-- statement-breakpoint
CREATE TABLE coordinator_settlements (
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,execution_id),
  FOREIGN KEY(run_id,thread_id,execution_id) REFERENCES run_executions(run_id,thread_id,execution_id)
);
-- statement-breakpoint
ALTER TABLE run_thread_bindings ADD COLUMN link TEXT;
-- statement-breakpoint
UPDATE run_thread_bindings SET link=(SELECT link FROM run_blocks b WHERE b.run_id=run_thread_bindings.run_id AND b.thread_id=run_thread_bindings.thread_id);
-- statement-breakpoint
ALTER TABLE run_events ADD COLUMN binding_id TEXT REFERENCES run_thread_bindings(id);
-- statement-breakpoint
UPDATE run_events SET binding_id=(SELECT id FROM run_thread_bindings b WHERE b.run_id=run_events.run_id AND b.block_id=run_events.block_id AND b.role IN ('direct-worker','coordinator'));
-- statement-breakpoint
CREATE TRIGGER immutable_activation_report BEFORE UPDATE OF activation_id,result_message,execution_id,fingerprint,status,exit_id,acknowledgement_json ON runtime_reports
WHEN OLD.activation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Activation results are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_execution_identity BEFORE UPDATE OF run_id,block_id,thread_id,execution_id ON run_executions
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.block_id IS NOT OLD.block_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.execution_id IS NOT OLD.execution_id
BEGIN SELECT RAISE(ABORT, 'Execution identity is immutable'); END;
-- statement-breakpoint
-- Rebuilding referenced tables leaves SQLite's deferred DROP counters outstanding even
-- after their rows are restored. Validate every live FK before clearing those counters.
CREATE TABLE coordinator_migration_integrity (valid INTEGER NOT NULL CHECK(valid=1));
-- statement-breakpoint
INSERT INTO coordinator_migration_integrity SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
-- statement-breakpoint
DROP TABLE coordinator_migration_integrity;
-- statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
-- statement-breakpoint
ALTER TABLE run_closures ADD COLUMN coordination_json TEXT;
-- statement-breakpoint
CREATE TABLE coordinator_native_items (
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  thread_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(activation_id,thread_id,item_id)
);
-- statement-breakpoint
ALTER TABLE run_attention ADD COLUMN binding_id TEXT REFERENCES run_thread_bindings(id);

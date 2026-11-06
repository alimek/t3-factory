-- Historical results keep their captured policy; only new version-four finals create checkpoints.
CREATE TABLE assessment_checkpoints (
 activation_id TEXT PRIMARY KEY REFERENCES run_activations(id),
 report_id TEXT NOT NULL UNIQUE REFERENCES runtime_reports(id),
 reporter_thread_id TEXT NOT NULL,
 reporter_execution_id TEXT NOT NULL,
 evidence_json TEXT NOT NULL
);
-- statement-breakpoint
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
-- statement-breakpoint
CREATE TABLE coordinator_bootstrap_recoveries (
 activation_id TEXT PRIMARY KEY REFERENCES run_coordinator_commands(activation_id),
 source_execution_id TEXT NOT NULL,
 intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id)
);
-- statement-breakpoint
CREATE TRIGGER immutable_assessment_checkpoint_update BEFORE UPDATE ON assessment_checkpoints BEGIN SELECT RAISE(ABORT,'Assessment checkpoints are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_assessment_checkpoint_delete BEFORE DELETE ON assessment_checkpoints BEGIN SELECT RAISE(ABORT,'Assessment checkpoints are immutable'); END;
-- statement-breakpoint
CREATE TABLE coordinator_native_commands (
 run_id TEXT NOT NULL REFERENCES runs(id),
 block_id TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 execution_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 PRIMARY KEY(run_id,thread_id,item_id,fingerprint)
);

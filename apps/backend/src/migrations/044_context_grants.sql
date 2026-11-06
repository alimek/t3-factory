-- Historical context_granted flags have no originating call and grant no replay authority.
ALTER TABLE run_coordinator_commands ADD COLUMN context_call_id TEXT;
-- statement-breakpoint
ALTER TABLE run_coordinator_commands ADD COLUMN context_reply_json TEXT;
-- statement-breakpoint
CREATE TABLE coordinator_question_replies (
  attention_id TEXT PRIMARY KEY REFERENCES run_attention(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  request_id TEXT NOT NULL,
  message TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE REFERENCES operation_intents(id),
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  binding_id TEXT NOT NULL REFERENCES run_thread_bindings(id),
  UNIQUE(run_id,request_id)
);

-- statement-breakpoint
ALTER TABLE run_coordinator_commands ADD COLUMN intent_id TEXT REFERENCES operation_intents(id);
-- statement-breakpoint
ALTER TABLE run_coordinator_commands ADD COLUMN context_execution_id TEXT;
-- statement-breakpoint
CREATE TRIGGER immutable_context_grant BEFORE UPDATE OF context_execution_id,context_call_id,context_reply_json ON run_coordinator_commands
WHEN OLD.context_granted=1 AND (NEW.context_execution_id IS NOT OLD.context_execution_id OR NEW.context_call_id IS NOT OLD.context_call_id OR NEW.context_reply_json IS NOT OLD.context_reply_json)
BEGIN SELECT RAISE(ABORT,'Context grant origin and receipt are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER immutable_coordinator_answer BEFORE UPDATE ON coordinator_question_replies
BEGIN SELECT RAISE(ABORT,'Coordinator answer is immutable'); END;
-- statement-breakpoint
CREATE TABLE coordinator_native_human_replies (
  run_id TEXT NOT NULL REFERENCES runs(id),
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,item_id)
);

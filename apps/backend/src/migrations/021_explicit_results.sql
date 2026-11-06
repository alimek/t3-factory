-- Existing reports retain their accepted protocol and per-key semantics.
ALTER TABLE runtime_reports ADD COLUMN final_contract INTEGER NOT NULL DEFAULT 0;
-- statement-breakpoint
CREATE UNIQUE INDEX one_final_result ON runtime_reports(run_id,block_id,execution_id) WHERE final_contract=1;
-- statement-breakpoint
ALTER TABLE runtime_reports ADD COLUMN completion_eligible_at TEXT;

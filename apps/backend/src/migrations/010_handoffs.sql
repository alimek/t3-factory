ALTER TABLE operation_intents ADD COLUMN report_id TEXT REFERENCES runtime_reports(id)
-- statement-breakpoint
ALTER TABLE operation_intents ADD COLUMN source_block_id TEXT
-- statement-breakpoint
ALTER TABLE operation_intents ADD COLUMN exit_id TEXT

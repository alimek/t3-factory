-- A title generation records when it reached its outcome, which bounds how long Factory still tries
-- to clean up its title thread, and claims its one Stop and its one T3 thread settlement before each
-- request is sent, so neither is ever repeated. Generations recorded earlier keep a null outcome
-- time and get no cleanup. No existing data changes.
ALTER TABLE run_title_generations ADD COLUMN ended_at TEXT
-- statement-breakpoint
ALTER TABLE run_title_generations ADD COLUMN stop_requested_at TEXT
-- statement-breakpoint
ALTER TABLE run_title_generations ADD COLUMN settle_requested_at TEXT

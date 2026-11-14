-- A pending title generation records its title thread's launch request when Start accepts the Run,
-- so the launch intent is durable before any dispatch. launch_sent_at marks that the request may
-- have reached T3, and thread_id binds the thread T3 launched. No existing data changes.
ALTER TABLE run_title_generations ADD COLUMN launch_payload_json TEXT
-- statement-breakpoint
ALTER TABLE run_title_generations ADD COLUMN launch_sent_at TEXT
-- statement-breakpoint
ALTER TABLE run_title_generations ADD COLUMN thread_id TEXT

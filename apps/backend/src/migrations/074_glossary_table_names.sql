-- Rename live tables to current glossary terms, preserving all rows.
ALTER TABLE coordinator_settlements RENAME TO t3_thread_settlements
-- statement-breakpoint
ALTER TABLE run_delegations RENAME TO activation_messages
-- statement-breakpoint
ALTER TABLE coordinator_revisits RENAME TO repeated_visits

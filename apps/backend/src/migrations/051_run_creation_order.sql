-- Run navigation orders by when the entry was created as a draft, separate from execution start.
-- Existing Runs were created when they started, so they keep their relative order.
ALTER TABLE runs ADD COLUMN created_at TEXT NOT NULL DEFAULT ''
-- statement-breakpoint
UPDATE runs SET created_at=started_at

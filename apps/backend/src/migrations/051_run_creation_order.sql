-- Run navigation orders by when the entry was created as a draft, separate from execution start,
-- and breaks equal times by a key the draft already had, so Start never moves its entry.
-- Existing Runs were created when they started and tied by id, so they keep their relative order.
ALTER TABLE runs ADD COLUMN created_at TEXT NOT NULL DEFAULT ''
-- statement-breakpoint
ALTER TABLE runs ADD COLUMN creation_key TEXT NOT NULL DEFAULT ''
-- statement-breakpoint
UPDATE runs SET created_at=started_at,creation_key=id

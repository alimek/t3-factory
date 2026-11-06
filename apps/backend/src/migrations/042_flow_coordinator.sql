-- Explicit authoring choice only: never infer a root from historical Agent settings.
ALTER TABLE flows ADD COLUMN coordinator_json TEXT NOT NULL DEFAULT 'null'
  CHECK (json_valid(coordinator_json));
-- statement-breakpoint
-- Normalize only the embedded Flow definition. Execution contracts, Agent settings,
-- result history and operational payloads retain their historical identities.
DROP TRIGGER immutable_run_snapshot_update;
-- statement-breakpoint
UPDATE run_snapshots SET snapshot_json = json_insert(snapshot_json, '$.flow.coordinator', NULL);
-- statement-breakpoint
CREATE TRIGGER immutable_run_snapshot_update BEFORE UPDATE ON run_snapshots BEGIN SELECT RAISE(ABORT, 'Run snapshots are immutable'); END;

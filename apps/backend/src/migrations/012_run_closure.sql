CREATE TABLE run_closures (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('finished','stopped')),
  generation INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  frontier_json TEXT NOT NULL
)
-- statement-breakpoint
CREATE TRIGGER immutable_run_closure_update BEFORE UPDATE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_closure_delete BEFORE DELETE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END

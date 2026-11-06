-- Coordinator Stop was disabled through schema 31. This ledger selects the new
-- thread/tree contract without reinterpreting any historical direct-worker intent.
CREATE TABLE coordinator_stop_requests (
  intent_id TEXT PRIMARY KEY REFERENCES operation_intents(id),
  scope TEXT NOT NULL CHECK(scope IN ('owned-tree','queued-execution'))
);

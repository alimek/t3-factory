-- Factory decides worker thread completion from T3 alone: no active run, no pending native
-- request and a settled delegated wait for the latest run. Storage that only supported
-- Factory's own completion model is dropped: native delegation sources, obligations and
-- command receipts, per-execution selection evidence, remote and peer tracking, worker
-- lineage, Run-conversation settlement claims, activation coverage evidence, release
-- frontiers and closure coordination evidence. Recorded closure frontiers lose their queue
-- fields, which Factory no longer reads. Open and closed Runs are otherwise kept.
DROP TABLE coordinator_native_items
-- statement-breakpoint
DROP TABLE coordinator_native_obligations
-- statement-breakpoint
DROP TABLE coordinator_native_commands
-- statement-breakpoint
DROP TABLE coordinator_local_executions
-- statement-breakpoint
DROP TABLE coordinator_remote_work
-- statement-breakpoint
DROP TABLE coordinator_peer_obligations
-- statement-breakpoint
DROP TABLE run_worker_activations
-- statement-breakpoint
DROP TABLE run_root_settlements
-- statement-breakpoint
ALTER TABLE run_activations DROP COLUMN coverage
-- statement-breakpoint
ALTER TABLE run_activations DROP COLUMN evidence_json
-- statement-breakpoint
ALTER TABLE coordinator_releases DROP COLUMN frontier_json
-- statement-breakpoint
DROP TRIGGER immutable_run_closure_update
-- statement-breakpoint
ALTER TABLE run_closures DROP COLUMN coordination_json
-- statement-breakpoint
UPDATE run_closures SET frontier_json=(
  SELECT json_group_array(json_remove(value,'$.queuedRunIds','$.queueNextCursor','$.queueObservedAt') ORDER BY key)
  FROM json_each(run_closures.frontier_json)
)
-- statement-breakpoint
UPDATE run_closures SET root_frontier_json=(
  SELECT json_group_array(json_remove(value,'$.queuedRunIds','$.queueNextCursor','$.queueObservedAt') ORDER BY key)
  FROM json_each(run_closures.root_frontier_json)
) WHERE root_frontier_json IS NOT NULL
-- statement-breakpoint
CREATE TRIGGER immutable_run_closure_update BEFORE UPDATE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END

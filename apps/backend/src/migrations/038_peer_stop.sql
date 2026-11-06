-- Peer safety obligations are separate from local reporting/execution membership.
CREATE TABLE coordinator_peer_obligations (
  run_id TEXT NOT NULL REFERENCES runs(id),
  environment_id TEXT NOT NULL,
  root_thread_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('member','queued','execution','native','nested')),
  reference TEXT NOT NULL,
  PRIMARY KEY(run_id,environment_id,root_thread_id,thread_id,kind,reference)
);
-- statement-breakpoint
-- Existing closed evidence is local. Add its actual saved environment, preserving
-- every historical execution/status/time and the order of frontier entries.
DROP TRIGGER immutable_run_closure_update;
-- statement-breakpoint
UPDATE run_closures SET frontier_json = (
  SELECT json_group_array(json(entry)) FROM (
    SELECT json_set(j.value,'$.environmentId',c.environment_id) AS entry
    FROM json_each(run_closures.frontier_json) j
    JOIN runs r ON r.id=run_closures.run_id
    JOIN t3_authorization_contexts c ON c.id=r.context_id
    ORDER BY j.key
  )
);

-- statement-breakpoint
CREATE TRIGGER immutable_run_closure_update BEFORE UPDATE ON run_closures BEGIN SELECT RAISE(ABORT, 'Closure evidence is immutable'); END;

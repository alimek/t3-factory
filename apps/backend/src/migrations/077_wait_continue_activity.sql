DROP INDEX run_activity_by_run
-- statement-breakpoint
CREATE INDEX run_activity_by_run ON run_events(run_id, observed_at DESC)
WHERE kind IN ('execution-observed','report-accepted','working-reported','human-answered','attention-appeared','handoff-released','continuation-passed','wait-elapsed','wait-continued','run-settled','run-activated')

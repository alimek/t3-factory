-- Run-owned evidence has no Block membership or reporting authority.
CREATE TABLE run_root_obligations (
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('member','execution','native','remote','command','followup')),
  reference TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,kind,reference)
);
-- statement-breakpoint
CREATE TABLE run_root_stop_intents (
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  cause TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','reserved','uncertain','acknowledged')),
  PRIMARY KEY(run_id,cause)
);
-- statement-breakpoint
ALTER TABLE run_coordinators ADD COLUMN freshness TEXT NOT NULL DEFAULT 'unknown';
-- statement-breakpoint
ALTER TABLE run_coordinators ADD COLUMN observed_at TEXT;
-- statement-breakpoint
ALTER TABLE run_coordinators ADD COLUMN pending_request_count INTEGER;
-- statement-breakpoint
ALTER TABLE run_coordinators ADD COLUMN queued_count INTEGER;
-- statement-breakpoint
ALTER TABLE run_closures ADD COLUMN root_frontier_json TEXT;
-- statement-breakpoint
INSERT INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT run_id,thread_id,'execution',execution_id FROM run_coordinators WHERE thread_id IS NOT NULL AND execution_id IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT c.run_id,r.thread_id,'execution',c.parent_execution_id FROM run_coordinator_commands c JOIN run_coordinators r ON r.run_id=c.run_id WHERE r.thread_id IS NOT NULL AND c.parent_execution_id IS NOT NULL;
-- statement-breakpoint
ALTER TABLE run_coordinator_commands ADD COLUMN cancelled_at TEXT;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT o.run_id,r.thread_id,'native',json_array(json_extract(o.evidence_json,'$.itemId'),json_extract(o.evidence_json,'$.parentRunId'),json_extract(o.evidence_json,'$.fingerprint')) FROM run_coordinator_obligations o JOIN run_coordinators r ON r.run_id=o.run_id WHERE r.thread_id IS NOT NULL AND json_extract(o.evidence_json,'$.itemId') IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT run_id,COALESCE(json_extract(evidence_json,'$.threadId'),json_extract(evidence_json,'$.result.childThreadId')),'member',json_object('threadId',COALESCE(json_extract(evidence_json,'$.threadId'),json_extract(evidence_json,'$.result.childThreadId')),'parentThreadId',json_extract(evidence_json,'$.parentThreadId')) FROM run_coordinator_obligations WHERE COALESCE(json_extract(evidence_json,'$.threadId'),json_extract(evidence_json,'$.result.childThreadId')) IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT run_id,json_extract(evidence_json,'$.result.childThreadId'),'execution',json_extract(evidence_json,'$.result.childRunId') FROM run_coordinator_obligations WHERE json_extract(evidence_json,'$.result.childThreadId') IS NOT NULL AND json_extract(evidence_json,'$.result.childRunId') IS NOT NULL;
-- statement-breakpoint
UPDATE run_coordinator_commands SET state='uncertain' WHERE state='pending' AND activation_id IN (SELECT c.activation_id FROM run_coordinator_commands c JOIN run_coordinators r ON r.run_id=c.run_id WHERE r.state IN ('reserved','uncertain') AND c.rowid=(SELECT MIN(f.rowid) FROM run_coordinator_commands f WHERE f.run_id=c.run_id));
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT o.run_id,r.thread_id,'execution',json_extract(o.evidence_json,'$.parentRunId') FROM run_coordinator_obligations o JOIN run_coordinators r ON r.run_id=o.run_id WHERE r.thread_id IS NOT NULL AND json_extract(o.evidence_json,'$.parentRunId') IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT run_id,json_extract(evidence_json,'$.result.childThreadId'),'execution',json_extract(evidence_json,'$.result.latestTerminalRunId') FROM run_coordinator_obligations WHERE json_extract(evidence_json,'$.result.childThreadId') IS NOT NULL AND json_extract(evidence_json,'$.result.latestTerminalRunId') IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT run_id,json_extract(evidence_json,'$.threadId'),'execution',json_extract(evidence_json,'$.activeRunId') FROM run_coordinator_obligations WHERE json_extract(evidence_json,'$.threadId') IS NOT NULL AND json_extract(evidence_json,'$.activeRunId') IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO run_root_obligations(run_id,thread_id,kind,reference)
SELECT run_id,json_extract(evidence_json,'$.threadId'),'execution',json_extract(evidence_json,'$.latestRunId') FROM run_coordinator_obligations WHERE json_extract(evidence_json,'$.threadId') IS NOT NULL AND json_extract(evidence_json,'$.latestRunId') IS NOT NULL;
-- statement-breakpoint
CREATE TABLE run_root_cancelled_controls (
  run_id TEXT NOT NULL REFERENCES run_coordinators(run_id),
  source_execution_id TEXT NOT NULL,
  PRIMARY KEY(run_id,source_execution_id)
);

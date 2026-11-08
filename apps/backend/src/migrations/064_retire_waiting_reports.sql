-- Workers report only working and finished: a working report stays current across the turns of
-- its Block activation, so a question in chat needs no report and creates no Needs input.
-- Each pending conversation-waiting question settles as upgraded-to-working; its question text,
-- wait record, acknowledgement, report status on its execution and events are kept. The latest
-- pending question of a Block's latest activation becomes that activation's current working
-- report, with the question as its message, even after an earlier final result, which stays
-- recorded but is no longer current. retired_wait_id marks the row as derived by this upgrade
-- rather than reported by an Agent. No launch or send is created, so no worker resumes.
ALTER TABLE working_reports ADD COLUMN retired_wait_id TEXT REFERENCES coordinator_waits(id)
-- statement-breakpoint
CREATE TEMP TABLE retired_waits AS
SELECT
  w.id AS wait_id, w.activation_id, q.id AS attention_id, q.run_id, q.block_id, q.execution_id,
  q.binding_id, q.message, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS retired_at,
  w.rowid = (
    SELECT MAX(o.rowid) FROM coordinator_waits o JOIN run_attention p ON p.id=o.attention_id
    WHERE o.activation_id=w.activation_id AND p.settled_at IS NULL
  ) AND w.activation_id = (
    SELECT l.id FROM run_activations l WHERE l.run_id=q.run_id AND l.block_id=q.block_id
    ORDER BY l.rowid DESC LIMIT 1
  ) AS current
FROM coordinator_waits w JOIN run_attention q ON q.id=w.attention_id
WHERE q.kind='conversation-waiting' AND q.settled_at IS NULL
-- statement-breakpoint
UPDATE run_attention
SET settled_at=(SELECT r.retired_at FROM retired_waits r WHERE r.attention_id=run_attention.id),
  settlement_reason='upgraded-to-working'
WHERE id IN (SELECT attention_id FROM retired_waits)
-- statement-breakpoint
INSERT INTO run_events (run_id, block_id, execution_id, binding_id, kind, source_key, cause_id, observed_at)
SELECT run_id, block_id, execution_id, binding_id, 'attention-settled', 'attention-upgraded:' || attention_id,
  attention_id, retired_at
FROM retired_waits ORDER BY rowid
-- statement-breakpoint
INSERT INTO working_reports (
  id, run_id, block_id, activation_id, execution_id, fingerprint, message, acknowledgement_json,
  accepted_at, retired_wait_id
)
SELECT
  'retired-wait:' || r.wait_id, r.run_id, r.block_id, r.activation_id, NULL, 'retired-wait:' || r.wait_id,
  r.message,
  json_object('code', 'ACCEPTED', 'reportId', 'retired-wait:' || r.wait_id, 'acceptedAt', r.retired_at, 'state', 'working'),
  r.retired_at, r.wait_id
FROM retired_waits r
WHERE r.current AND NOT EXISTS(
  SELECT 1 FROM working_reports x WHERE x.activation_id=r.activation_id AND x.replaced_at IS NULL
)
ORDER BY r.rowid
-- statement-breakpoint
UPDATE run_blocks
SET state=CASE WHEN state='waiting' THEN 'working' ELSE state END,
  report_status=CASE
    WHEN EXISTS(
      SELECT 1 FROM working_reports w
      WHERE w.run_id=run_blocks.run_id AND w.block_id=run_blocks.block_id AND w.replaced_at IS NULL
        AND w.activation_id=(SELECT l.id FROM run_activations l WHERE l.run_id=run_blocks.run_id AND l.block_id=run_blocks.block_id ORDER BY l.rowid DESC LIMIT 1)
    ) THEN 'working'
    WHEN EXISTS(
      SELECT 1 FROM runtime_reports f
      WHERE f.run_id=run_blocks.run_id AND f.block_id=run_blocks.block_id AND f.status='finished'
        AND f.activation_id=(SELECT l.id FROM run_activations l WHERE l.run_id=run_blocks.run_id AND l.block_id=run_blocks.block_id ORDER BY l.rowid DESC LIMIT 1)
    ) THEN 'finished'
  END
WHERE report_status='waiting'
-- statement-breakpoint
UPDATE run_activations SET phase='assessing' WHERE phase='waiting-worker'
-- statement-breakpoint
DROP TABLE retired_waits

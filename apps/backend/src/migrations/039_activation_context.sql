-- Retain activation input independently of delivery payload cleanup.
ALTER TABLE run_activations ADD COLUMN task_context TEXT;
-- statement-breakpoint
UPDATE run_activations AS a SET task_context=(
  SELECT CASE
    WHEN i.report_id IS NOT NULL THEN (SELECT result_message FROM runtime_reports WHERE id=i.report_id)
    WHEN i.occurrence_id IS NULL THEN (SELECT input FROM runs WHERE id=a.run_id)
    ELSE NULL
  END FROM operation_intents i WHERE i.run_id=a.run_id AND i.cause=a.cause
);
-- statement-breakpoint
-- Unacknowledged Human launches still retain the embedded native request.
-- Already erased historical answers cannot be reconstructed from a one-way hash.
WITH messages AS (
  SELECT a.id, a.run_id, a.block_id, substr(json_extract(i.payload_json,'$.message'), instr(json_extract(i.payload_json,'$.message'), char(10))+1) AS tail
  FROM run_activations a JOIN operation_intents i ON i.run_id=a.run_id AND i.cause=a.cause
  WHERE a.task_context IS NULL AND i.occurrence_id IS NOT NULL AND i.payload_json IS NOT NULL
), requests AS (
  SELECT id,run_id,block_id,substr(tail,1,instr(tail,char(10))-1) AS request FROM messages
), inputs AS (
  SELECT r.id,json_extract(r.request,'$.message') AS message,json_extract(r.request,'$.task') AS task,
    json_extract(agent.value,'$.prompt') || char(10,10) || 'Task context:' || char(10) AS prefix,
    char(10,10) || 'Distinguish finished work, questions and blockers. Summarize your own result.' AS suffix
  FROM requests r JOIN run_snapshots s ON s.run_id=r.run_id
  JOIN json_each(s.snapshot_json,'$.flow.graph.blocks') b ON json_extract(b.value,'$.id')=r.block_id
  JOIN json_each(s.snapshot_json,'$.agents') agent ON json_extract(agent.value,'$.id')=json_extract(b.value,'$.agentId')
  WHERE json_valid(r.request)
)
UPDATE run_activations SET task_context=(SELECT CASE
    WHEN message IS NOT NULL THEN message
    WHEN substr(task,1,length(prefix))=prefix AND substr(task,-length(suffix))=suffix
      THEN substr(task,length(prefix)+1,length(task)-length(prefix)-length(suffix))
    ELSE NULL END FROM inputs WHERE inputs.id=run_activations.id)
WHERE id IN (SELECT id FROM inputs);

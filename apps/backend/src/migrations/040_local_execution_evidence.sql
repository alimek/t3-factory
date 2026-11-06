-- Independently observed immutable metadata. No selection is inferred from a plan or acceptance.
CREATE TABLE coordinator_local_executions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  parent_thread_id TEXT,
  provider_instance_id TEXT,
  model TEXT,
  ordinal INTEGER,
  PRIMARY KEY(run_id,thread_id,execution_id)
);
-- statement-breakpoint
INSERT INTO coordinator_local_executions(run_id,thread_id,execution_id,parent_thread_id,ordinal)
SELECT e.run_id,e.thread_id,e.execution_id,p.thread_id,e.ordinal FROM run_executions e
JOIN run_thread_bindings b ON b.id=e.binding_id LEFT JOIN run_thread_bindings p ON p.id=b.parent_binding_id
JOIN runs r ON r.id=e.run_id JOIN run_snapshots s ON s.run_id=r.id
WHERE json_extract(s.snapshot_json,'$.executionContract')='coordinator-child-v1';
-- statement-breakpoint
-- A saved positive designation proves that the old implementation independently
-- matched this exact activation root's selection. Native acceptance alone does not.
WITH roots AS (
  SELECT a.run_id,b.thread_id AS parent_thread_id,a.evidence_json,
    COALESCE(json_extract(v.receipt_json,'$.threadId'),json_extract(d.accepted_json,'$.result.childThreadId')) AS thread_id,
    COALESCE(json_extract(v.receipt_json,'$.runId'),json_extract(d.accepted_json,'$.result.childRunId')) AS execution_id,
    json_extract(d.accepted_json,'$.result.providerInstanceId') AS provider_instance_id,
    json_extract(d.accepted_json,'$.result.model') AS model
  FROM run_activations a
  LEFT JOIN coordinator_revisits v ON v.activation_id=a.id
  JOIN run_delegations d ON d.activation_id=COALESCE(v.original_activation_id,a.id)
  JOIN run_blocks b ON b.run_id=a.run_id AND b.block_id=a.block_id
  WHERE json_extract(a.evidence_json,'$.designation')=1
    AND (v.activation_id IS NULL OR v.receipt_json IS NOT NULL)
)
INSERT INTO coordinator_local_executions(run_id,thread_id,execution_id,parent_thread_id,provider_instance_id,model)
SELECT run_id,thread_id,execution_id,parent_thread_id,provider_instance_id,model FROM roots r
WHERE execution_id IS NOT NULL AND provider_instance_id IS NOT NULL AND model IS NOT NULL
  AND EXISTS (SELECT 1 FROM json_each(r.evidence_json,'$.members') m
    WHERE json_extract(m.value,'$.role')='worker' AND json_extract(m.value,'$.threadId')=r.thread_id
      AND EXISTS (SELECT 1 FROM json_each(m.value,'$.executionIds') e WHERE e.value=r.execution_id))
ON CONFLICT(run_id,thread_id,execution_id) DO UPDATE SET provider_instance_id=excluded.provider_instance_id,model=excluded.model
WHERE coordinator_local_executions.provider_instance_id IS NULL AND coordinator_local_executions.model IS NULL
  AND coordinator_local_executions.parent_thread_id IS excluded.parent_thread_id;

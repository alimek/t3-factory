-- Exact native references are observation obligations, not execution membership.
CREATE TABLE coordinator_native_obligations (
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  PRIMARY KEY(run_id,thread_id,execution_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
);
-- statement-breakpoint
-- Preserve exact references already retained by earlier schemas, without inventing
-- execution status or activation membership. Native fingerprints are not identities.
INSERT OR IGNORE INTO coordinator_native_obligations
SELECT a.run_id,a.block_id,n.thread_id,n.execution_id
FROM coordinator_native_items n JOIN run_activations a ON a.id=n.activation_id;
-- statement-breakpoint
INSERT OR IGNORE INTO coordinator_native_obligations
SELECT a.run_id,a.block_id,t.thread_id,t.execution_id
FROM coordinator_task_results t JOIN run_activations a ON a.id=t.activation_id;
-- statement-breakpoint
INSERT OR IGNORE INTO coordinator_native_obligations
SELECT a.run_id,a.block_id,json_extract(d.accepted_json,'$.result.childThreadId'),j.value
FROM run_delegations d JOIN run_activations a ON a.id=d.activation_id,
json_each(json_array(json_extract(d.accepted_json,'$.result.childRunId'),json_extract(d.accepted_json,'$.result.latestTerminalRunId'))) j
WHERE json_extract(d.accepted_json,'$.result.childThreadId') IS NOT NULL AND j.value IS NOT NULL;
-- statement-breakpoint
INSERT OR IGNORE INTO coordinator_native_obligations
SELECT a.run_id,a.block_id,json_extract(v.receipt_json,'$.threadId'),json_extract(v.receipt_json,'$.runId')
FROM coordinator_revisits v JOIN run_activations a ON a.id=v.activation_id
WHERE json_extract(v.receipt_json,'$.threadId') IS NOT NULL AND json_extract(v.receipt_json,'$.runId') IS NOT NULL;

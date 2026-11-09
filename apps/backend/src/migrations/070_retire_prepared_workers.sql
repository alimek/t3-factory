-- Worktree Runs no longer prepare idle workers: a later Agent Block launches its worker with its
-- first message when it is first reached. Prepared threads stay recorded in run_prepared_workers
-- as history.
--
-- A first visit already queued as a send to a prepared thread keeps its target and request key,
-- since T3 may have accepted it. Its thread becomes the Block's worker now, as acknowledging that
-- send used to make it, so the send is delivered or recovered like any send to a bound worker.
INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,link)
SELECT lower(hex(randomblob(16))),p.run_id,p.block_id,c.environment_id,p.thread_id,'worker',p.link
FROM run_prepared_workers p
JOIN run_blocks b ON b.run_id=p.run_id AND b.block_id=p.block_id
JOIN runs r ON r.id=p.run_id
JOIN t3_authorization_contexts c ON c.id=r.context_id
WHERE b.thread_id IS NULL AND EXISTS (
  SELECT 1 FROM operation_intents i
  WHERE i.run_id=p.run_id AND i.block_id=p.block_id AND i.kind='send'
    AND i.state IN ('pending','reserved','uncertain')
    AND json_extract(i.target_json,'$.threadId')=p.thread_id
)
ON CONFLICT DO NOTHING
-- statement-breakpoint
UPDATE run_blocks
SET thread_id=(SELECT p.thread_id FROM run_prepared_workers p WHERE p.run_id=run_blocks.run_id AND p.block_id=run_blocks.block_id),
  link=(SELECT p.link FROM run_prepared_workers p WHERE p.run_id=run_blocks.run_id AND p.block_id=run_blocks.block_id)
WHERE thread_id IS NULL AND EXISTS (
  SELECT 1 FROM run_prepared_workers p JOIN operation_intents i ON i.run_id=p.run_id AND i.block_id=p.block_id
  WHERE p.run_id=run_blocks.run_id AND p.block_id=run_blocks.block_id AND i.kind='send'
    AND i.state IN ('pending','reserved','uncertain')
    AND json_extract(i.target_json,'$.threadId')=p.thread_id
)
-- statement-breakpoint
-- Unresolved preparations are cancelled, so an uncertain idle launch is abandoned rather than
-- resent; a Block not yet reached launches a new worker instead.
UPDATE operation_intents
SET state = 'cancelled',
  problem = 'Factory no longer prepares idle workers. This Block launches its worker when it is first reached.'
WHERE kind = 'prepare' AND state IN ('pending', 'reserved', 'uncertain')

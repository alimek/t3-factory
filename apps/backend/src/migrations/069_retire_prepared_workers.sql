-- Worktree Runs no longer prepare idle workers: a later Agent Block launches its worker with its
-- first message when it is first reached. Unresolved preparations are cancelled, so an
-- uncertain idle launch is abandoned rather than resent. Prepared threads stay recorded in
-- run_prepared_workers as history; a Block not yet visited launches a new worker instead.
UPDATE operation_intents
SET state = 'cancelled',
  problem = 'Factory no longer prepares idle workers. This Block launches its worker when it is first reached.'
WHERE kind = 'prepare' AND state IN ('pending', 'reserved', 'uncertain')

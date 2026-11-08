-- Settled replaces the permanent Finished outcome. A Run settles automatically when its work is
-- done or when the user settles it, and any accepted Block report returns it to Active, so a
-- Task may again hold more than one Active Run. Closed Finished Runs become Settled with their
-- handoff gate open, so a later report from one of their Blocks reactivates them; their recorded
-- closure, events and reports are kept. Snooze applies only to Active Runs, so the wake triggers
-- no longer consult closures.
DROP INDEX one_open_run_per_task
-- statement-breakpoint
ALTER TABLE runs ADD COLUMN settled_at TEXT
-- statement-breakpoint
UPDATE runs SET settled_at=closed_at,closed_at=NULL,outcome=NULL,gate_open=1 WHERE outcome='finished'
-- statement-breakpoint
DROP TRIGGER wake_run_on_new_attention
-- statement-breakpoint
CREATE TRIGGER wake_run_on_new_attention AFTER INSERT ON run_attention
WHEN NEW.settled_at IS NULL
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=1
  WHERE run_id=NEW.run_id AND snoozed=1
    AND NOT EXISTS(SELECT 1 FROM run_snooze_attention WHERE run_id=NEW.run_id AND attention_id=NEW.id);
END
-- statement-breakpoint
DROP TRIGGER wake_run_on_increased_native_attention
-- statement-breakpoint
CREATE TRIGGER wake_run_on_increased_native_attention AFTER UPDATE OF pending_request_count ON run_blocks
WHEN NEW.pending_request_count > OLD.pending_request_count
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=1
  WHERE run_id=NEW.run_id AND snoozed=1
    AND EXISTS(SELECT 1 FROM run_attention WHERE run_id=NEW.run_id AND block_id=NEW.block_id
      AND kind='native-request' AND settled_at IS NULL);
END

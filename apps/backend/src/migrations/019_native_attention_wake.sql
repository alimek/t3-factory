CREATE TRIGGER wake_run_on_increased_native_attention AFTER UPDATE OF pending_request_count ON run_blocks
WHEN NEW.pending_request_count > OLD.pending_request_count
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=1
  WHERE run_id=NEW.run_id AND snoozed=1
    AND NOT EXISTS(SELECT 1 FROM run_closures WHERE run_id=NEW.run_id)
    AND EXISTS(SELECT 1 FROM run_attention WHERE run_id=NEW.run_id AND block_id=NEW.block_id
      AND kind='native-request' AND settled_at IS NULL);
END

CREATE TABLE run_presentation (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  snoozed INTEGER NOT NULL DEFAULT 0 CHECK(snoozed IN (0,1)),
  woke INTEGER NOT NULL DEFAULT 0 CHECK(woke IN (0,1)),
  CHECK(NOT (snoozed=1 AND woke=1))
)
-- statement-breakpoint
CREATE TABLE run_snooze_attention (
  run_id TEXT NOT NULL REFERENCES run_presentation(run_id),
  attention_id TEXT NOT NULL REFERENCES run_attention(id),
  PRIMARY KEY(run_id,attention_id)
)
-- statement-breakpoint
CREATE TRIGGER wake_run_on_new_attention AFTER INSERT ON run_attention
WHEN NEW.settled_at IS NULL
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=1
  WHERE run_id=NEW.run_id AND snoozed=1
    AND NOT EXISTS(SELECT 1 FROM run_closures WHERE run_id=NEW.run_id)
    AND NOT EXISTS(SELECT 1 FROM run_snooze_attention WHERE run_id=NEW.run_id AND attention_id=NEW.id);
END
-- statement-breakpoint
CREATE TRIGGER settle_run_presentation AFTER INSERT ON run_closures
BEGIN
  UPDATE run_presentation SET snoozed=0,woke=0 WHERE run_id=NEW.run_id;
END

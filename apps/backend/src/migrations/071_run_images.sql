-- Run images. Bytes live content-addressed under FACTORY_HOME/images/<sha256>; a staged row
-- exists only while its file is complete. An accepted Start attaches staged images to the Run in
-- manifest order, and that reference keeps them out of the staging sweep for good.
CREATE TABLE staged_images (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  staged_at TEXT NOT NULL
)
-- statement-breakpoint
CREATE TABLE run_images (
  run_id TEXT NOT NULL REFERENCES runs(id),
  image_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  sha256 TEXT NOT NULL REFERENCES staged_images(sha256),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, image_id),
  UNIQUE (run_id, sha256)
)
-- statement-breakpoint
CREATE INDEX run_images_sha256 ON run_images(sha256)
-- statement-breakpoint
CREATE TRIGGER immutable_run_images_update BEFORE UPDATE ON run_images BEGIN SELECT RAISE(ABORT, 'Run images are immutable'); END
-- statement-breakpoint
CREATE TRIGGER immutable_run_images_delete BEFORE DELETE ON run_images BEGIN SELECT RAISE(ABORT, 'Run images are immutable'); END
-- statement-breakpoint
-- The ordered prompt segments as accepted. runs.input keeps the worker-readable text frozen at Start.
ALTER TABLE runs ADD COLUMN prompt_segments_json TEXT
-- statement-breakpoint
UPDATE runs SET prompt_segments_json = json_array(json_object('type', 'text', 'text', input))
-- statement-breakpoint
CREATE TRIGGER immutable_run_prompt_segments BEFORE UPDATE OF prompt_segments_json ON runs
WHEN OLD.prompt_segments_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Run prompt segments are immutable'); END

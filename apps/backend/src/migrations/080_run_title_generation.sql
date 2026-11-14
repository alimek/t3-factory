-- Generate Run titles is one installation-wide setting, off until the host owner enables it with a
-- T3 provider instance and model. Every installation, new or upgraded, starts with it off; no
-- existing data changes. The revision lets Start notice a change between its checks and acceptance.
-- The latest eligibility diagnostic is kept beside the setting until a later one replaces it.
CREATE TABLE run_title_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  provider_instance_id TEXT,
  model_id TEXT,
  model_options_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  diagnostic_run_id TEXT REFERENCES runs(id),
  diagnostic_message TEXT,
  diagnostic_at TEXT,
  CHECK ((model_id IS NULL) = (provider_instance_id IS NULL)),
  CHECK ((model_id IS NULL) = (model_options_json IS NULL)),
  CHECK (enabled = 0 OR model_id IS NOT NULL),
  CHECK ((diagnostic_run_id IS NULL) = (diagnostic_message IS NULL)),
  CHECK ((diagnostic_run_id IS NULL) = (diagnostic_at IS NULL))
)
-- statement-breakpoint
INSERT INTO run_title_settings (singleton) VALUES (1)
-- statement-breakpoint
-- At most one title generation per Run, recorded at Start acceptance with the configuration it
-- captured. Its id is the generation's opaque capability, never shown in Run reads. Runs from
-- before this migration have none.
CREATE TABLE run_title_generations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'dropped', 'timed-out', 'cancelled', 'skipped', 'failed')),
  reason TEXT,
  provider_instance_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_options_json TEXT NOT NULL,
  model_label TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  deadline_at TEXT NOT NULL,
  automatic_title TEXT NOT NULL,
  generated_title TEXT,
  thread_link TEXT,
  created_at TEXT NOT NULL
)

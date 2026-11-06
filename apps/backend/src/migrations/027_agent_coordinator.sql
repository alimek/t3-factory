-- Definitions only. Never rewrite historical Run snapshots or pending payloads.
-- SQL NULL marks an older definition awaiting local capability discovery.
-- JSON null is an explicit unconfigured choice.
ALTER TABLE agents ADD COLUMN coordinator_json TEXT
  CHECK (coordinator_json IS NULL OR json_valid(coordinator_json));

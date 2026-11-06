-- Old immutable snapshots without reportingProtocol retain runtime-mcp-v1.
-- Observation metadata only: never retain a second copy of conversation text.
CREATE TABLE report_items (
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(run_id,block_id,item_id),
  FOREIGN KEY(run_id,block_id) REFERENCES run_blocks(run_id,block_id)
)

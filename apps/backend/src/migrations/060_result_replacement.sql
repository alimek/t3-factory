-- A Block activation's newest finished report is its result, so an activation can hold
-- several result versions and release each version its handoffs depend on. Result rows stay
-- immutable; only their per-activation uniqueness goes. Releases are keyed by the released
-- result version instead of the activation. Every report and recorded release is kept.
DROP INDEX one_activation_result
-- statement-breakpoint
CREATE INDEX runtime_reports_activation ON runtime_reports(activation_id)
-- statement-breakpoint
CREATE TABLE result_releases (
  report_id TEXT PRIMARY KEY REFERENCES runtime_reports(id),
  activation_id TEXT NOT NULL REFERENCES run_activations(id),
  generation INTEGER NOT NULL,
  context_id TEXT NOT NULL,
  released_at TEXT NOT NULL
)
-- statement-breakpoint
INSERT INTO result_releases(report_id, activation_id, generation, context_id, released_at)
SELECT report_id, activation_id, generation, context_id, released_at
FROM coordinator_releases ORDER BY rowid
-- statement-breakpoint
DROP TABLE coordinator_releases
-- statement-breakpoint
CREATE INDEX result_releases_activation ON result_releases(activation_id)

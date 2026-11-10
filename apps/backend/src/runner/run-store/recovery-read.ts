import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export function recoveryRows(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      attention_id: string | null;
      block_id: string;
      source_execution_id: string;
      intent_id: string;
      requested_at: string;
      settled_at: string | null;
      result_json: string | null;
    }>`SELECT r.*,i.result_json FROM report_recoveries r JOIN operation_intents i ON i.id=r.intent_id WHERE r.run_id=${id}`;
    return rows.map((r) => ({
      attentionId: r.attention_id,
      blockId: r.block_id,
      sourceExecutionId: r.source_execution_id,
      intentId: r.intent_id,
      requestedAt: r.requested_at,
      settledAt: r.settled_at,
      executionId: r.result_json
        ? (
            JSON.parse(r.result_json) as {
              runId: string;
            }
          ).runId
        : null,
    }));
  });
}

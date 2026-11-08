import { attention } from "./runner-attention.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** An accepted report settles the Block's missing-report obligations, retaining attention/event history. */
export function settleCoordinatorReports(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      execution_id: string;
    }>`SELECT DISTINCT a.execution_id FROM run_attention a JOIN run_executions e ON e.run_id=a.run_id AND e.block_id=a.block_id AND e.execution_id=a.execution_id JOIN run_thread_bindings b ON b.id=e.binding_id WHERE a.run_id=${runId} AND a.block_id=${blockId} AND a.kind='missing-report' AND a.settled_at IS NULL AND b.role='worker'`;
    for (const row of rows)
      yield* attention(
        sql,
        { id: runId },
        { block_id: blockId },
        row.execution_id,
        "missing-report",
        false,
        time,
      );
  });
}

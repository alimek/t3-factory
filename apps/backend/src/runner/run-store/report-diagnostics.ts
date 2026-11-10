import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { reportDiagnostic } from "../../runtime-report-diagnostic.ts";
import type { RuntimeReply } from "../../runtime-types.ts";
import { now } from "../../time.ts";
import { observeAttention, settleAttention } from "./attention.ts";
import type { ReportTarget } from "./records.ts";
import { advanceGeneration } from "./steps.ts";

/** A rejected report for a known Block is attention, never an execution transition or a
 * second copy of the report. */
export function recordReportVerdict(
  sql: SqlClient.SqlClient,
  { runRow: run, block, activationId }: ReportTarget,
  reply: RuntimeReply,
) {
  return Effect.gen(function* () {
    const diagnostic = reportDiagnostic(reply);
    if (!run.gate_open || !block.execution_id) return diagnostic;
    const [binding] = yield* sql<{
      id: string;
    }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND block_id=${block.block_id} AND thread_id=${block.thread_id} AND role='worker'`;
    if (!binding) return diagnostic;
    const time = yield* now;
    if (reply.code === "ACCEPTED") {
      yield* settleReportRejections(sql, run.id, block.block_id, time);
      return diagnostic;
    }
    // A rejected replacement leaves the visit's accepted result standing and owes nothing.
    const accepted = yield* sql`SELECT id FROM runtime_reports WHERE activation_id=${activationId}`;
    if (accepted.length) return diagnostic;
    const scope = { block_id: block.block_id, bindingId: binding.id };
    yield* observeAttention(sql, run.id, scope, block.execution_id, "report-problem", true, time);
    yield* sql`UPDATE run_attention SET source_key='report-rejected:' || id,message=${`${diagnostic.code}: ${diagnostic.reason} ${diagnostic.next}`} WHERE run_id=${run.id} AND binding_id=${binding.id} AND execution_id=${block.execution_id} AND kind='report-problem' AND settled_at IS NULL`;
    yield* advanceGeneration(sql, run.id);
    return diagnostic;
  });
}

/** An accepted report or settled recovery ends the Block's rejection diagnostics, retaining their history. */
export function settleReportRejections(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      execution_id: string;
      binding_id: string;
    }>`SELECT id,execution_id,binding_id FROM run_attention WHERE run_id=${runId} AND block_id=${blockId} AND kind='report-problem' AND source_key LIKE 'report-rejected:%' AND settled_at IS NULL`;
    yield* settleAttention(
      sql,
      rows.map((row) => ({
        id: row.id,
        runId,
        blockId,
        executionId: row.execution_id,
        bindingId: row.binding_id,
      })),
      "report-accepted",
      time,
    );
  });
}

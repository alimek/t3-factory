import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RuntimeBinding, RuntimeReply } from "./runtime-types.ts";
import type { BlockRow, ReportRunRow } from "./runner-types.ts";
import { attention } from "./runner-attention.ts";
import { reportDiagnostic } from "./runtime-report-diagnostic.ts";
import { now } from "./time.ts";

/** Called only after native correlation and the durable caller checks. Rejection is
 * attention, never an execution transition or a second copy of the report. */
export function recordReportVerdict(
  sql: SqlClient.SqlClient,
  binding: RuntimeBinding,
  run: ReportRunRow,
  block: BlockRow,
  reply: RuntimeReply,
  retryOnly: boolean,
) {
  return Effect.gen(function* () {
    const diagnostic = reportDiagnostic(reply);
    if (retryOnly || !run.gate_open || run.closed_at || block.execution_id !== binding.runId)
      return diagnostic;
    const [execution] = yield* sql<{
      binding_id: string;
    }>`SELECT e.binding_id FROM run_executions e JOIN run_thread_bindings b ON b.id=e.binding_id WHERE e.run_id=${run.id} AND e.block_id=${binding.blockId} AND e.thread_id=${binding.threadId} AND e.execution_id=${binding.runId} AND b.role='worker'`;
    if (!execution) return diagnostic;
    const scope = { block_id: binding.blockId, bindingId: execution.binding_id };
    const time = yield* now;
    if (reply.code === "ACCEPTED") {
      yield* settleReportRejections(sql, run.id, binding.blockId, binding.runId, time);
    } else {
      // A failed attempt to overwrite an accepted final cannot create a new obligation.
      const accepted =
        yield* sql`SELECT id FROM runtime_reports WHERE run_id=${run.id} AND block_id=${binding.blockId} AND activation_id=(SELECT activation_id FROM run_executions WHERE binding_id=${execution.binding_id} AND execution_id=${binding.runId})`;
      if (accepted.length) return diagnostic;
      yield* attention(sql, run, scope, binding.runId, "report-problem", true, time);
      yield* sql`UPDATE run_attention SET source_key='report-rejected:' || id,message=${`${diagnostic.code}: ${diagnostic.reason} ${diagnostic.next}`} WHERE run_id=${run.id} AND binding_id=${execution.binding_id} AND execution_id=${binding.runId} AND kind='report-problem' AND settled_at IS NULL`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
    }
    return diagnostic;
  });
}

/** Accepted correction/recovery settles diagnostics only, retaining the rejection history. */
export function settleReportRejections(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  executionId: string,
  time: string,
  completed = false,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      execution_id: string;
      binding_id: string;
    }>`SELECT a.id,a.execution_id,a.binding_id FROM run_attention a JOIN run_executions e ON e.run_id=a.run_id AND e.binding_id=a.binding_id AND e.execution_id=a.execution_id WHERE a.run_id=${runId} AND a.block_id=${blockId} AND a.kind='report-problem' AND a.source_key LIKE 'report-rejected:%' AND a.settled_at IS NULL AND (a.execution_id=${executionId} OR (e.activation_id=(SELECT activation_id FROM run_executions WHERE run_id=${runId} AND block_id=${blockId} AND execution_id=${executionId}) AND (${completed ? 1 : 0}=1 OR NOT EXISTS(SELECT 1 FROM report_recoveries r WHERE r.run_id=a.run_id AND r.block_id=a.block_id AND r.source_execution_id=a.execution_id AND r.settled_at IS NULL))))`;
    for (const row of rows) {
      yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='report-accepted' WHERE id=${row.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${runId},${blockId},${row.execution_id},${row.binding_id},'attention-settled',${"attention-settled:" + row.id},${row.id},${time})`;
    }
  });
}

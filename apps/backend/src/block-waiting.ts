import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { acceptedTransition, type RuntimeReport } from "./runtime-types.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";
import { settleForReport } from "./block-report.ts";
import type { ReportTarget } from "./runner-reports.ts";

/** A waiting report is the Block's question until a later turn of its worker thread or its next
 * report settles it. */
export function acceptWaiting(
  sql: SqlClient.SqlClient,
  target: ReportTarget,
  report: RuntimeReport,
  fingerprint: string,
) {
  const { runRow, block, activationId } = target;
  return Effect.gen(function* () {
    const [binding] = yield* sql<{
      id: string;
    }>`SELECT id FROM run_thread_bindings WHERE run_id=${runRow.id} AND block_id=${block.block_id} AND thread_id=${block.thread_id} AND role='worker'`;
    const time = yield* now,
      id = yield* newId,
      attentionId = yield* newId;
    const executionId = block.execution_id ?? "";
    const reply = acceptedTransition(
      { code: "ACCEPTED", reportId: id, acceptedAt: time },
      "waiting",
      "waiting",
    );
    yield* settleForReport(sql, target, time, report.status);
    yield* sql`UPDATE run_blocks SET state='waiting',report_status='waiting',problem=NULL WHERE run_id=${runRow.id} AND block_id=${block.block_id}`;
    yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,appeared_at,message,binding_id) VALUES(${attentionId},${runRow.id},${block.block_id},${executionId},'conversation-waiting',${"attention:" + attentionId},${time},${report.message!},${binding?.id ?? null})`;
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${block.execution_id},${binding?.id ?? null},'attention-appeared',${"attention:" + attentionId},${attentionId},${time})`;
    yield* sql`INSERT INTO coordinator_waits(id,activation_id,fingerprint,acknowledgement_json,target_binding_id,target_execution_id,attention_id) VALUES(${id},${activationId},${fingerprint},${JSON.stringify(reply)},${binding?.id ?? null},${block.execution_id},${attentionId})`;
    yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    return reply;
  });
}

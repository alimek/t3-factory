import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { acceptedTransition, type RuntimeReport } from "./runtime-types.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";
import { settleForReport } from "./block-report.ts";
import type { ReportTarget } from "./runner-reports.ts";

/** A working report becomes the activation's current report, shown with its message. */
export function acceptWorking(
  sql: SqlClient.SqlClient,
  target: ReportTarget,
  report: RuntimeReport,
  fingerprint: string,
) {
  const { runRow, block, activationId } = target;
  return Effect.gen(function* () {
    const id = yield* newId,
      time = yield* now;
    const reply = acceptedTransition(
      { code: "ACCEPTED", reportId: id, acceptedAt: time },
      "working",
      "working",
    );
    yield* settleForReport(sql, target, time, report.status);
    yield* sql`INSERT INTO working_reports(id,run_id,block_id,activation_id,execution_id,fingerprint,message,acknowledgement_json,accepted_at) VALUES(${id},${runRow.id},${block.block_id},${activationId},${block.execution_id},${fingerprint},${report.message!},${JSON.stringify(reply)},${time})`;
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${block.execution_id},'working-reported',${"working:" + id},${id},${time})`;
    yield* sql`UPDATE run_blocks SET state='working',report_status='working',problem=NULL WHERE run_id=${runRow.id} AND block_id=${block.block_id}`;
    yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    return reply;
  });
}

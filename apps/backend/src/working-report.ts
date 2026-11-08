import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { acceptedTransition, type RuntimeReply, type RuntimeReport } from "./runtime-types.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";
import { replaceWorking, settleCoordinatorReports } from "./coordinator-report.ts";
import { settleCoordinatorWaits } from "./coordinator-conversation.ts";
import { settlePending } from "./runner-attention.ts";
import type { ReportTarget } from "./runner-reports.ts";

/** The latest working report is the activation's current report; an identical one returns its acknowledgement. */
export function acceptWorking(
  sql: SqlClient.SqlClient,
  { runRow, block, activationId }: ReportTarget,
  report: RuntimeReport,
  fingerprint: string,
) {
  return Effect.gen(function* () {
    const [current] = yield* sql<{
      fingerprint: string;
      acknowledgement_json: string;
    }>`SELECT fingerprint,acknowledgement_json FROM working_reports WHERE activation_id=${activationId} AND replaced_at IS NULL`;
    if (current?.fingerprint === fingerprint)
      return JSON.parse(current.acknowledgement_json) as RuntimeReply;
    const id = yield* newId,
      time = yield* now;
    const reply = acceptedTransition(
      { code: "ACCEPTED", reportId: id, acceptedAt: time },
      "working",
      "working",
    );
    yield* replaceWorking(sql, activationId, time);
    yield* sql`INSERT INTO working_reports(id,run_id,block_id,activation_id,execution_id,fingerprint,message,acknowledgement_json,accepted_at) VALUES(${id},${runRow.id},${block.block_id},${activationId},${block.execution_id},${fingerprint},${report.message!},${JSON.stringify(reply)},${time})`;
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${block.execution_id},'working-reported',${"working:" + id},${id},${time})`;
    yield* sql`UPDATE run_blocks SET state='working',report_status='working',problem=NULL WHERE run_id=${runRow.id} AND block_id=${block.block_id}`;
    // Any accepted report recovers earlier failures and missing reports and replaces the question.
    yield* settlePending(
      sql,
      runRow.id,
      block.block_id,
      "execution-failed",
      "report-accepted",
      time,
    );
    yield* settleCoordinatorReports(sql, runRow.id, block.block_id, time);
    yield* settleCoordinatorWaits(sql, runRow.id, block.block_id, time, true);
    yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    return reply;
  });
}

/** Working messages that are the current report of each Block's latest activation. */
export function currentWorkingMessages(sql: SqlClient.SqlClient, runId?: string) {
  return sql<{
    run_id: string;
    block_id: string;
    message: string;
  }>`SELECT w.run_id,w.block_id,w.message FROM working_reports w WHERE (${runId ?? null} IS NULL OR w.run_id=${runId ?? null}) AND w.replaced_at IS NULL AND w.activation_id=(SELECT a.id FROM run_activations a WHERE a.run_id=w.run_id AND a.block_id=w.block_id ORDER BY a.rowid DESC LIMIT 1)`;
}

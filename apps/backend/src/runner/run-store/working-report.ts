import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import { acceptedTransition, type RuntimeReport } from "../../runtime-types.ts";
import { now } from "../../time.ts";
import { settleForReport } from "./current-report.ts";
import type { ReportTarget, WorkingReportRecord } from "./records.ts";
import { writeBlockState } from "./blocks.ts";
import { reportedState } from "../report-rules.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

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
    const record: WorkingReportRecord = {
      id,
      run_id: runRow.id,
      block_id: block.block_id,
      activation_id: activationId,
      execution_id: block.execution_id,
      fingerprint,
      message: report.message!,
      acknowledgement_json: JSON.stringify(reply),
      accepted_at: time,
      replaced_at: null,
    };
    yield* sql`INSERT INTO working_reports(id,run_id,block_id,activation_id,execution_id,fingerprint,message,acknowledgement_json,accepted_at) VALUES(${record.id},${record.run_id},${record.block_id},${record.activation_id},${record.execution_id},${record.fingerprint},${record.message},${record.acknowledgement_json},${record.accepted_at})`;
    yield* appendTimelineEvent(sql, {
      kind: "working-reported",
      runId: runRow.id,
      blockId: block.block_id,
      executionId: block.execution_id,
      reportId: id,
      observedAt: time,
    });
    yield* writeBlockState(
      sql,
      { runId: runRow.id, blockId: block.block_id },
      reportedState(runRow.definitions, block.block_id, "working"),
      {
        report_status: "working",
        problem: null,
      },
    );
    yield* advanceGeneration(sql, runRow.id);
    return reply;
  });
}

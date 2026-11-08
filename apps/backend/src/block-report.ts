import { attention, settlePending } from "./runner-attention.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ReportTarget } from "./runner-reports.ts";
import type { RuntimeReply } from "./runtime-types.ts";

export type CurrentReport = {
  readonly status: "working" | "finished";
  readonly fingerprint: string;
  readonly acknowledgement: RuntimeReply;
  readonly message: string | null;
};

/**
 * The current report of each Block's latest activation, in one Run or all: its current working
 * report, else its newest result. Every accepted report first ends the working report
 * (`settleForReport`), so a current one is newer than every result. A working report stays
 * current across later turns of the worker thread until the next report replaces it.
 */
export function currentReports(sql: SqlClient.SqlClient, runId: string | null) {
  return Effect.map(
    sql<{
      run_id: string;
      block_id: string;
      activation_id: string;
      report: string | null;
    }>`SELECT a.run_id,a.block_id,a.id AS activation_id,COALESCE(
      (SELECT json_object('status','working','fingerprint',fingerprint,'acknowledgement',json(acknowledgement_json),'message',message) FROM working_reports WHERE activation_id=a.id AND replaced_at IS NULL),
      (SELECT json_object('status','finished','fingerprint',fingerprint,'acknowledgement',json(acknowledgement_json),'message',result_message) FROM runtime_reports WHERE activation_id=a.id AND status='finished' ORDER BY rowid DESC LIMIT 1)) AS report
      FROM run_activations a WHERE (${runId} IS NULL OR a.run_id=${runId}) AND a.rowid=(SELECT MAX(l.rowid) FROM run_activations l WHERE l.run_id=a.run_id AND l.block_id=a.block_id)`,
    (rows) =>
      rows.map((row) => ({
        runId: row.run_id,
        blockId: row.block_id,
        activationId: row.activation_id,
        report: row.report === null ? null : (JSON.parse(row.report) as CurrentReport),
      })),
  );
}

/** Working messages that are the current report of each Block's latest activation. */
export function currentWorkingMessages(sql: SqlClient.SqlClient, runId?: string) {
  return Effect.map(currentReports(sql, runId ?? null), (reports) =>
    reports.flatMap((entry) =>
      entry.report?.status === "working"
        ? [{ run_id: entry.runId, block_id: entry.blockId, message: entry.report.message }]
        : [],
    ),
  );
}

/** An identical repeat of the Block's current report returns that report's stored acknowledgement,
 * unless an execution failure or missing report is pending; then the repeat is a new report that
 * settles it. */
export function repeatedReport(
  sql: SqlClient.SqlClient,
  { runRow, block }: ReportTarget,
  fingerprint: string,
) {
  return Effect.gen(function* () {
    const current = (yield* currentReports(sql, runRow.id)).find(
      (entry) => entry.blockId === block.block_id,
    )?.report;
    if (current?.fingerprint !== fingerprint) return undefined;
    const pending =
      yield* sql`SELECT id FROM run_attention WHERE run_id=${runRow.id} AND block_id=${block.block_id} AND settled_at IS NULL AND kind IN ('execution-failed','missing-report')`;
    return pending.length ? undefined : current.acknowledgement;
  });
}

/** What every accepted report ends before it is recorded: the activation's working report, the
 * Block's execution failures and its missing reports, keeping their history.
 * Record the accepted status on the work period for presentation and linked recovery. */
export function settleForReport(
  sql: SqlClient.SqlClient,
  { runRow, block, activationId }: ReportTarget,
  time: string,
  status: CurrentReport["status"],
) {
  return Effect.gen(function* () {
    yield* sql`UPDATE run_executions SET report_status=${status},problem=CASE WHEN problem='missing-report' THEN NULL ELSE problem END WHERE run_id=${runRow.id} AND block_id=${block.block_id} AND execution_id=${block.execution_id}`;
    yield* sql`UPDATE working_reports SET replaced_at=${time} WHERE activation_id=${activationId} AND replaced_at IS NULL`;
    yield* settlePending(
      sql,
      runRow.id,
      block.block_id,
      "execution-failed",
      "report-accepted",
      time,
    );
    yield* settleMissingReports(sql, runRow.id, block.block_id, time);
  });
}

function settleMissingReports(
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

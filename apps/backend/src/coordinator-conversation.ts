import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { acceptedTransition, type RuntimeReply, type RuntimeReport } from "./runtime-types.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";
import { settleCoordinatorReports } from "./coordinator-report.ts";
import type { ReportTarget } from "./runner-reports.ts";

/** The latest waiting report is the Block's question; an identical one returns its acknowledgement. */
export function acceptCoordinatorWait(
  sql: SqlClient.SqlClient,
  { runRow, block, activationId }: ReportTarget,
  report: RuntimeReport,
  fingerprint: string,
) {
  return Effect.gen(function* () {
    const [pending] = yield* sql<{
      fingerprint: string;
      acknowledgement_json: string;
    }>`SELECT w.fingerprint,w.acknowledgement_json FROM coordinator_waits w JOIN run_attention a ON a.id=w.attention_id WHERE w.activation_id=${activationId} AND a.settled_at IS NULL ORDER BY w.rowid DESC LIMIT 1`;
    if (pending?.fingerprint === fingerprint)
      return JSON.parse(pending.acknowledgement_json) as RuntimeReply;
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
    yield* sql`UPDATE run_blocks SET state='waiting',report_status='waiting' WHERE run_id=${runRow.id} AND block_id=${block.block_id}`;
    yield* settleCoordinatorWaits(sql, runRow.id, block.block_id, time, true);
    yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,appeared_at,message,binding_id) VALUES(${attentionId},${runRow.id},${block.block_id},${executionId},'conversation-waiting',${"attention:" + attentionId},${time},${report.message!},${binding?.id ?? null})`;
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${block.execution_id},${binding?.id ?? null},'attention-appeared',${"attention:" + attentionId},${attentionId},${time})`;
    yield* sql`INSERT INTO coordinator_waits(id,activation_id,fingerprint,acknowledgement_json,target_binding_id,target_execution_id,attention_id) VALUES(${id},${activationId},${fingerprint},${JSON.stringify(reply)},${binding?.id ?? null},${block.execution_id},${attentionId})`;
    yield* settleCoordinatorReports(sql, runRow.id, block.block_id, time);
    yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    return reply;
  });
}

/** Any later turn in the worker thread resumes its question; a report always replaces it. */
export function settleCoordinatorWaits(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
  all = false,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      execution_id: string;
      binding_id: string | null;
    }>`SELECT a.id,a.execution_id,a.binding_id FROM run_attention a JOIN coordinator_waits w ON w.attention_id=a.id WHERE a.run_id=${runId} AND a.block_id=${blockId} AND a.settled_at IS NULL AND (${all ? 1 : 0}=1 OR EXISTS(SELECT 1 FROM run_executions old JOIN run_executions next ON next.binding_id=old.binding_id AND next.ordinal>old.ordinal WHERE old.binding_id=w.target_binding_id AND old.execution_id=w.target_execution_id))`;
    for (const row of rows) {
      yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='completed' WHERE id=${row.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${runId},${blockId},${row.execution_id},${row.binding_id},'attention-settled',${"attention-settled:" + row.id},${row.id},${time})`;
    }
  });
}

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RuntimeBinding, RuntimeReport } from "./runtime-types.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";
import { settleCoordinatorReports } from "./coordinator-report.ts";

/** A worker's waiting report targets its own exact execution; Needs input follows the newest one. */
export function acceptCoordinatorWait(
  sql: SqlClient.SqlClient,
  binding: RuntimeBinding,
  report: RuntimeReport,
  fingerprint: string,
) {
  return Effect.gen(function* () {
    const [activation] = yield* sql<{
      id: string;
    }>`SELECT activation_id AS id FROM run_executions WHERE run_id=${binding.factoryRunId} AND thread_id=${binding.threadId} AND execution_id=${binding.runId}`;
    const [target] = yield* sql<{
      id: string;
      execution_id: string;
    }>`SELECT b.id,e.execution_id FROM run_thread_bindings b JOIN run_executions e ON e.binding_id=b.id WHERE b.run_id=${binding.factoryRunId} AND b.block_id=${binding.blockId} AND b.role='worker' AND e.activation_id=${activation!.id} AND e.execution_id=${binding.runId}`;
    if (target) {
      const newer =
        yield* sql`SELECT next.execution_id FROM run_executions next JOIN run_executions old ON old.binding_id=next.binding_id WHERE old.binding_id=${target.id} AND old.execution_id=${target.execution_id} AND next.ordinal>old.ordinal`;
      if (newer.length) return { code: "WAITING_TARGET_SUPERSEDED" };
    }
    if (!target) return { code: "WAITING_TARGET_UNVERIFIED" };
    const time = yield* now,
      id = yield* newId,
      attentionId = yield* newId;
    const reply = {
      code: "ACCEPTED",
      reportId: id,
      executionId: binding.runId,
      blockId: binding.blockId,
      acceptedAt: time,
    };
    yield* settleCoordinatorWaits(sql, binding.factoryRunId, binding.blockId, time, true);
    yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,appeared_at,message,binding_id) VALUES(${attentionId},${binding.factoryRunId},${binding.blockId},${target.execution_id},'conversation-waiting',${"attention:" + attentionId},${time},${report.message!},${target.id})`;
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${binding.factoryRunId},${binding.blockId},${target.execution_id},${target.id},'attention-appeared',${"attention:" + attentionId},${attentionId},${time})`;
    yield* sql`INSERT INTO coordinator_waits VALUES(${id},${activation!.id},${binding.runId},${report.key},${fingerprint},${JSON.stringify(reply)},${target.id},${target.execution_id},${attentionId})`;
    yield* settleCoordinatorReports(sql, binding.factoryRunId, binding.blockId, time);
    yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${binding.factoryRunId}`;
    return reply;
  });
}

/** Only a later exact execution on the question's own thread takes over its waiting. */
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
      binding_id: string;
    }>`SELECT a.id,a.execution_id,a.binding_id FROM run_attention a JOIN coordinator_waits w ON w.attention_id=a.id JOIN run_executions old ON old.binding_id=w.target_binding_id AND old.execution_id=w.target_execution_id WHERE a.run_id=${runId} AND a.block_id=${blockId} AND a.settled_at IS NULL AND (${all ? 1 : 0}=1 OR EXISTS(SELECT 1 FROM run_executions next WHERE next.binding_id=old.binding_id AND next.activation_id=old.activation_id AND next.ordinal>old.ordinal))`;
    for (const row of rows) {
      yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='completed' WHERE id=${row.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${runId},${blockId},${row.execution_id},${row.binding_id},'attention-settled',${"attention-settled:" + row.id},${row.id},${time})`;
    }
  });
}

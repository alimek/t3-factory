import { attention } from "./runner-attention.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RuntimeBinding, RuntimeReport, RuntimeReply } from "./runtime-types.ts";
/** Exact worker provenance has already passed the shared report boundary. */
function waitRetry(
  sql: SqlClient.SqlClient,
  binding: RuntimeBinding,
  report: RuntimeReport,
  fingerprint: string,
) {
  return Effect.gen(function* () {
    const [prior] = yield* sql<{
      fingerprint: string;
      acknowledgement_json: string;
    }>`SELECT w.fingerprint,w.acknowledgement_json FROM coordinator_waits w JOIN run_activations a ON a.id=w.activation_id WHERE a.run_id=${binding.factoryRunId} AND a.block_id=${binding.blockId} AND w.parent_execution_id=${binding.runId} AND w.report_key=${report.key}`;
    return prior
      ? prior.fingerprint === fingerprint
        ? (JSON.parse(prior.acknowledgement_json) as RuntimeReply)
        : { code: "KEY_CONFLICT" }
      : undefined;
  });
}

/** The caller must be the activation's own worker execution; one immutable final per activation. */
export function workerReport(
  sql: SqlClient.SqlClient,
  binding: RuntimeBinding,
  report: RuntimeReport,
  content: string,
) {
  return Effect.gen(function* () {
    const waitingRetry = yield* waitRetry(sql, binding, report, content);
    if (waitingRetry) return waitingRetry;
    const [worker] = yield* sql<{
      activation_id: string;
    }>`SELECT w.activation_id FROM run_worker_activations w JOIN run_executions e ON e.activation_id=w.activation_id AND e.binding_id=w.binding_id JOIN run_thread_bindings b ON b.id=w.binding_id WHERE e.run_id=${binding.factoryRunId} AND b.thread_id=${binding.threadId} AND e.execution_id=${binding.runId} AND b.role='worker'`;
    if (!worker) return { code: "UNBOUND_ACTIVATION" };
    const [prior] = yield* sql<{
      execution_id: string;
      fingerprint: string;
      acknowledgement_json: string;
    }>`SELECT * FROM runtime_reports WHERE activation_id=${worker.activation_id}`;
    if (prior)
      return prior.execution_id === binding.runId && prior.fingerprint === content
        ? (JSON.parse(prior.acknowledgement_json) as RuntimeReply)
        : { code: "FINAL_CONFLICT" };
    const failed =
      yield* sql`SELECT execution_id FROM run_executions WHERE activation_id=${worker.activation_id} AND engine_status IN ('failed','cancelled','interrupted','rolled_back')`;
    if (failed.length) return { code: "WORKER_FAILED" };
    if (
      report.status === "finished" &&
      (yield* sql`SELECT id FROM run_attention WHERE run_id=${binding.factoryRunId} AND block_id=${binding.blockId} AND kind='conversation-waiting' AND settled_at IS NULL`)
        .length
    )
      return { code: "HUMAN_REPLY_REQUIRED" };
    return undefined;
  });
}

/** Settle the activation's missing-report obligation, retaining attention/event history. */
export function settleCoordinatorReports(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      execution_id: string;
    }>`SELECT DISTINCT a.execution_id FROM run_attention a JOIN run_executions e ON e.run_id=a.run_id AND e.block_id=a.block_id AND e.execution_id=a.execution_id JOIN run_thread_bindings b ON b.id=e.binding_id WHERE a.run_id=${runId} AND a.block_id=${blockId} AND a.kind='missing-report' AND a.settled_at IS NULL AND b.role='worker' AND e.activation_id=(SELECT id FROM run_activations WHERE run_id=${runId} AND block_id=${blockId} ORDER BY rowid DESC LIMIT 1)`;
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

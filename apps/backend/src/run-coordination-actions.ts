import type { RunCoordinationActions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunRow } from "./runner-types.ts";
import { ownedRootControlExecutions } from "./run-control-recovery-proof.ts";

function actionReason(open: boolean, state: string) {
  if (!open) return "This Run no longer accepts coordination requests.";
  if (state === "stop-required")
    return "This owned control was rolled back. Ordinary recovery cannot restore its authority. Stop this Run; existing worker work is preserved.";
  if (state === "uncertain" || state === "reserved")
    return "Acknowledgement unknown. Work may already exist in T3; no replacement is authorized.";
  if (state !== "available")
    return `Request ${state}. Existing work and this request’s recorded history are retained.`;
  return "Request a fresh eligibility check. Continues in the same conversation and preserves existing worker work.";
}
export function readCoordinationActions(sql: SqlClient.SqlClient, run: RunRow) {
  return Effect.gen(function* () {
    const open = !!run.gate_open && !run.closed_at;
    const questionReplies = yield* sql<
      RunCoordinationActions["questionReplies"][number]
    >`SELECT q.attention_id AS attentionId,q.request_id AS requestId,q.message,i.state,json_extract(i.result_json,'$.runId') AS executionId FROM coordinator_question_replies q JOIN operation_intents i ON i.id=q.intent_id WHERE q.run_id=${run.id} ORDER BY q.rowid`;
    const owned = yield* ownedRootControlExecutions(sql, run.id);
    const rollbacks = yield* sql<{
      executionId: string;
    }>`SELECT execution_id AS executionId FROM run_events WHERE run_id=${run.id} AND block_id IS NULL AND engine_status='rolled_back' AND source_key='root-control-rolled-back:'||execution_id`;
    const sources = yield* sql<{
      sourceExecutionId: string;
      threadId: string;
      sourceStatus: string | null;
      state: string;
      executionId: string | null;
    }>`SELECT ids.execution_id AS sourceExecutionId,root.thread_id AS threadId,
      (SELECT e.engine_status FROM run_events e WHERE e.run_id=root.run_id AND e.block_id IS NULL AND e.execution_id=ids.execution_id AND e.engine_status IN ('failed','cancelled','interrupted') ORDER BY e.sequence DESC LIMIT 1) AS sourceStatus,
      CASE WHEN cancelled.source_execution_id IS NOT NULL THEN 'cancelled' WHEN r.completed_execution_id IS NOT NULL THEN 'completed' ELSE COALESCE(r.state,'available') END AS state,
      json_extract(r.acknowledgement_json,'$.runId') AS executionId
      FROM (SELECT execution_id FROM run_events WHERE run_id=${run.id} AND block_id IS NULL AND engine_status IN ('failed','cancelled','interrupted','rolled_back') UNION SELECT source_execution_id FROM run_control_recoveries WHERE run_id=${run.id}) ids
      JOIN run_coordinators root ON root.run_id=${run.id} LEFT JOIN run_control_recoveries r ON r.run_id=root.run_id AND r.source_execution_id=ids.execution_id LEFT JOIN run_root_cancelled_controls cancelled ON cancelled.run_id=root.run_id AND cancelled.source_execution_id=ids.execution_id WHERE root.state='acknowledged' ORDER BY ids.execution_id`;
    return {
      questionReplies,
      controlRecoveries: sources
        .map((row) =>
          rollbacks.some((r) => r.executionId === row.sourceExecutionId)
            ? { ...row, state: "stop-required", sourceStatus: "rolled_back" }
            : row,
        )
        .filter((row) => owned.some((e) => e.runId === row.sourceExecutionId))
        .map((row) => ({
          ...row,
          canRequest: open && row.state === "available",
          reason: actionReason(open, row.state),
        })),
    } satisfies RunCoordinationActions;
  });
}

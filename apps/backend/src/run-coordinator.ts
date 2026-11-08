import type { AgentExecutionSettings } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { threadHref } from "./thread-link.ts";

type RootRow = {
  freshness: "unknown" | "fresh" | "stale";
  observed_at: string | null;
  pending_operation_count: number;
  pending_stop_count: number;
  pending_request_count: number | null;
  queued_count: number | null;
  run_id: string;
  selection_json: string;
  request_key: string;
  payload_json: string | null;
  fingerprint: string;
  retry_scope: string | null;
  state: "pending" | "reserved" | "uncertain" | "acknowledged" | "cancelled";
  thread_id: string | null;
  execution_id: string | null;
  link: string | null;
  engine_status: string | null;
  instruction_version: number;
  problem: string | null;
};

/** Closed history may still show a Run conversation. New Runs do not write one. */
export function readRunCoordinator(sql: SqlClient.SqlClient, runId: string) {
  return Effect.gen(function* () {
    const [root] =
      yield* sql<RootRow>`SELECT r.*,(CASE WHEN r.state IN ('pending','reserved','uncertain') THEN 1 ELSE 0 END)+(SELECT COUNT(*) FROM run_coordinator_commands c WHERE c.run_id=r.run_id AND c.cancelled_at IS NULL AND c.state!='accepted')+(SELECT COUNT(*) FROM run_root_stop_intents s WHERE s.run_id=r.run_id AND s.state!='acknowledged')+(SELECT COUNT(*) FROM run_control_recoveries c WHERE c.run_id=r.run_id AND c.state!='acknowledged' AND NOT EXISTS(SELECT 1 FROM run_root_cancelled_controls x WHERE x.run_id=c.run_id AND x.source_execution_id=c.source_execution_id))+(SELECT COUNT(*) FROM run_root_obligations o WHERE o.run_id=r.run_id AND (o.kind='command' OR (o.kind='followup' AND o.thread_id=r.thread_id)) AND EXISTS(SELECT 1 FROM runs x WHERE x.id=r.run_id AND x.archived_at IS NULL AND x.settled_at IS NULL)) AS pending_operation_count,(SELECT COUNT(*) FROM run_root_stop_intents s WHERE s.run_id=r.run_id AND s.state!='acknowledged') AS pending_stop_count FROM run_coordinators r WHERE r.run_id=${runId}`;
    return root
      ? {
          freshness: root.freshness,
          observedAt: root.observed_at,
          pendingRequestCount: root.pending_request_count,
          queuedCount: root.queued_count,
          pendingOperationCount: root.pending_operation_count,
          pendingStopCount: root.pending_stop_count,
          selection: JSON.parse(root.selection_json) as AgentExecutionSettings,
          state: root.state,
          threadId: root.thread_id,
          executionId: root.execution_id,
          link: threadHref(root.link),
          engineStatus: root.engine_status,
          problem: root.problem,
        }
      : null;
  });
}

/** Historical Run-conversation executions Factory owned, for closed-Run history. */
export function ownedRootControlExecutions(sql: SqlClient.SqlClient, runId: string) {
  return sql<{
    runId: string;
  }>`SELECT execution_id AS runId FROM run_coordinators WHERE run_id=${runId} AND state='acknowledged' AND execution_id IS NOT NULL
    UNION SELECT parent_execution_id FROM run_coordinator_commands WHERE run_id=${runId} AND state IN ('issued','accepted') AND parent_execution_id IS NOT NULL
    UNION SELECT source_execution_id FROM run_control_recoveries WHERE run_id=${runId}
    UNION SELECT json_extract(acknowledgement_json,'$.runId') FROM run_control_recoveries recovery JOIN run_coordinators root USING(run_id) WHERE recovery.run_id=${runId} AND recovery.state='acknowledged' AND recovery.thread_id=root.thread_id AND json_extract(acknowledgement_json,'$.threadId')=root.thread_id AND json_extract(acknowledgement_json,'$.runId') IS NOT NULL`;
}

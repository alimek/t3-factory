import type * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
/** Only the exact durable recovery acknowledgement can discharge its historical P failure. */
export function recoveredRootFailures(sql: SqlClient.SqlClient, runId: string) {
  return sql<{
    threadId: string;
    executionId: string;
  }>`SELECT thread_id AS threadId,source_execution_id AS executionId FROM run_control_recoveries WHERE run_id=${runId} AND state='acknowledged' AND completed_execution_id=json_extract(acknowledgement_json,'$.runId') AND thread_id=json_extract(acknowledgement_json,'$.threadId')`;
}

/** Ownership comes from native acknowledgements, never from a later P turn or its order. */
export function ownedRootControlExecutions(sql: SqlClient.SqlClient, runId: string) {
  return sql<{
    runId: string;
  }>`SELECT execution_id AS runId FROM run_coordinators WHERE run_id=${runId} AND state='acknowledged' AND execution_id IS NOT NULL
    UNION SELECT parent_execution_id FROM run_coordinator_commands WHERE run_id=${runId} AND state IN ('issued','accepted') AND parent_execution_id IS NOT NULL
    UNION SELECT source_execution_id FROM run_control_recoveries WHERE run_id=${runId}
    UNION SELECT json_extract(acknowledgement_json,'$.runId') FROM run_control_recoveries recovery JOIN run_coordinators root USING(run_id) WHERE recovery.run_id=${runId} AND recovery.state='acknowledged' AND recovery.thread_id=root.thread_id AND json_extract(acknowledgement_json,'$.threadId')=root.thread_id AND json_extract(acknowledgement_json,'$.runId') IS NOT NULL`;
}

/** Lifetime failure facts are separate from the fresh whole-Run/Stop frontier. */
export function rootControlDispatchAllowed(sql: SqlClient.SqlClient, runId: string) {
  return Effect.gen(function* () {
    const pending =
      yield* sql`SELECT run_id FROM run_control_recoveries WHERE run_id=${runId} AND (state!='acknowledged' OR completed_execution_id IS NULL)`;
    if (pending.length) return false;
    const owned = yield* ownedRootControlExecutions(sql, runId);
    const recovered = yield* recoveredRootFailures(sql, runId);
    const failed = yield* sql<{
      execution_id: string;
      thread_id: string;
      engine_status: string;
    }>`SELECT e.execution_id,r.thread_id,e.engine_status FROM run_events e JOIN run_coordinators r ON r.run_id=e.run_id WHERE e.run_id=${runId} AND e.block_id IS NULL AND ((e.engine_status IN ('failed','cancelled','interrupted') AND e.source_key='root-control-failed:'||e.execution_id) OR (e.engine_status='rolled_back' AND e.source_key='root-control-rolled-back:'||e.execution_id))`;
    return failed.every(
      (failure) =>
        !owned.some((execution) => execution.runId === failure.execution_id) ||
        (failure.engine_status !== "rolled_back" &&
          recovered.some(
            (proof) =>
              proof.threadId === failure.thread_id && proof.executionId === failure.execution_id,
          )),
    );
  });
}

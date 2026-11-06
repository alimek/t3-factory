import { rootCommandMessage } from "./run-coordinator-commands.ts";
export { prepareRootCommands, persistRootCommands } from "./run-coordinator-commands.ts";
import type { AgentExecutionSettings, RunSnapshot } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { LaunchPayload, LaunchReference, T3Adapter, T3Target } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { fingerprint, intactPayload, runTarget } from "./runner-utils.ts";
import { recoverOperation } from "./runner-effects.ts";
import { now } from "./time.ts";
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

export function runCoordinatorPayload(
  snapshot: RunSnapshot,
  target: Pick<T3Target, "environmentId" | "projectId">,
  selection: AgentExecutionSettings,
  key: string,
  input: string,
  command?: object,
): LaunchPayload {
  return {
    environmentId: target.environmentId,
    projectId: target.projectId,
    clientRequestId: key,
    title: `${snapshot.flow.name}: Run conversation`.slice(0, 200),
    message: `You are the primary conversation for this Factory Run. Factory alone chooses eligible work, routing and Human decisions. Do not execute block work, invent transitions or launch children without an exact Factory-issued instruction. Execute only the single command below. On native next, end this turn. Never assess Block finals. Call factory-runtime.factory_context for current Run state. Do not poll, repair or create replacement work.\n\nCaptured Flow:\n${JSON.stringify(snapshot.flow.graph)}\n\nRun input:\n${input}${command ? `\n\n${rootCommandMessage(command)}` : ""}`,
    workspaceStrategy: { type: "root" },
    interactionMode: "default",
    modelSelection: {
      instanceId: selection.providerInstanceId,
      model: selection.modelId,
      options: Object.fromEntries(
        selection.modelOptions.map((option) => [option.id, option.value]),
      ),
    },
  };
}

export function persistRunCoordinator(
  sql: SqlClient.SqlClient,
  runId: string,
  selection: AgentExecutionSettings,
  payload: LaunchPayload,
  retryScope: string | null,
  time: string,
) {
  const body = JSON.stringify(payload);
  return sql`INSERT INTO run_coordinators(run_id,selection_json,request_key,payload_json,fingerprint,retry_scope,created_at,instruction_version) VALUES(${runId},${JSON.stringify(selection)},${payload.clientRequestId},${body},${fingerprint(body)},${retryScope},${time},1)`;
}

export function readRunCoordinator(sql: SqlClient.SqlClient, runId: string) {
  return Effect.gen(function* () {
    const [root] =
      yield* sql<RootRow>`SELECT r.*,(CASE WHEN r.state IN ('pending','reserved','uncertain') THEN 1 ELSE 0 END)+(SELECT COUNT(*) FROM run_coordinator_commands c WHERE c.run_id=r.run_id AND c.cancelled_at IS NULL AND c.state!='accepted')+(SELECT COUNT(*) FROM run_root_stop_intents s WHERE s.run_id=r.run_id AND s.state!='acknowledged')+(SELECT COUNT(*) FROM run_control_recoveries c WHERE c.run_id=r.run_id AND c.state!='acknowledged' AND NOT EXISTS(SELECT 1 FROM run_root_cancelled_controls x WHERE x.run_id=c.run_id AND x.source_execution_id=c.source_execution_id))+(SELECT COUNT(*) FROM run_root_obligations o WHERE o.run_id=r.run_id AND (o.kind='command' OR (o.kind='followup' AND o.thread_id=r.thread_id)) AND EXISTS(SELECT 1 FROM runs x WHERE x.id=r.run_id AND x.closed_at IS NULL)) AS pending_operation_count,(SELECT COUNT(*) FROM run_root_stop_intents s WHERE s.run_id=r.run_id AND s.state!='acknowledged') AS pending_stop_count FROM run_coordinators r WHERE r.run_id=${runId}`;
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

/** Root I/O uses the same Runner lane and owner; no block or worker membership is fabricated. */
export function openRunCoordinator(database: RunnerDatabase, t3: T3Adapter) {
  const { mutate, owner, runHeldUnderContext } = database;
  function markUnresolved(run: RunRow, message: string) {
    return mutate(
      run.id,
      (sql) =>
        sql`UPDATE run_coordinators SET state=CASE WHEN state='reserved' THEN 'uncertain' ELSE state END,problem=${message} WHERE run_id=${run.id} AND state NOT IN ('acknowledged','cancelled')`,
    ).pipe(Effect.asVoid);
  }
  function reserve(run: RunRow, root: RootRow, retryScope: string | null) {
    return mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* runHeldUnderContext(sql, run, true))) return false;
        const changed =
          yield* sql`UPDATE run_coordinators SET state='reserved',reserved_by=${owner.token},reserved_at=${yield* now},retry_scope=${root.state === "pending" ? retryScope : root.retry_scope},problem=NULL
          WHERE run_id=${run.id} AND state=${root.state}
          AND EXISTS(SELECT 1 FROM projects WHERE id=${run.project_id} AND workspace_root=${run.workspace_root} AND availability='available') RETURNING run_id`;
        if (changed.length) {
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          yield* sql`UPDATE run_coordinator_commands SET state='reserved' WHERE activation_id=(SELECT activation_id FROM run_coordinator_commands WHERE run_id=${run.id} ORDER BY rowid LIMIT 1) AND state='pending' AND cancelled_at IS NULL`;
        }
        return changed.length > 0;
      }),
    );
  }
  function acknowledge(run: RunRow, reference: LaunchReference) {
    if (reference.projectId !== run.t3_project_id)
      return Effect.fail(Error("Unexpected Run coordinator project"));
    return mutate(run.id, (sql) =>
      Effect.gen(function* () {
        const time = yield* now;
        const changed =
          yield* sql`UPDATE run_coordinators SET state='acknowledged',thread_id=${reference.threadId},execution_id=${reference.runId},link=${reference.link},engine_status=${reference.status},problem=NULL,payload_json=NULL,acknowledged_at=${time}
          WHERE run_id=${run.id} AND state='reserved' AND reserved_by=${owner.token} RETURNING run_id`;
        if (!changed.length) return;
        yield* sql`UPDATE run_coordinator_commands SET state='issued',parent_execution_id=${reference.runId} WHERE activation_id=(SELECT activation_id FROM run_coordinator_commands WHERE run_id=${run.id} ORDER BY rowid LIMIT 1) AND state IN ('pending','reserved','uncertain') AND cancelled_at IS NULL`;
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        yield* sql`INSERT INTO run_events(run_id,execution_id,kind,source_key,observed_at,engine_status) VALUES(${run.id},${reference.runId},'run-conversation-started','run-conversation',${time},${reference.status})`;
      }),
    );
  }
  function dispatch(run: RunRow, contextId: string | null) {
    return Effect.gen(function* () {
      const [root] = yield* database.transaction(
        (sql) => sql<RootRow>`SELECT * FROM run_coordinators WHERE run_id=${run.id}`,
      );
      if (!root || root.state === "acknowledged" || root.state === "cancelled") return;
      if (!run.gate_open) {
        yield* mutate(
          run.id,
          (sql) =>
            sql`UPDATE run_coordinators SET state='cancelled' WHERE run_id=${run.id} AND state='pending'`,
        );
        return;
      }
      if (contextId !== run.context_id) {
        yield* markUnresolved(
          run,
          "The Run conversation's authorization context is unavailable or changed.",
        );
        return;
      }
      yield* recoverOperation(
        Effect.gen(function* () {
          const support = yield* Effect.tryPromise(() => t3.inspectLaunchSupport(runTarget(run)));
          if (!support.supported) return yield* markUnresolved(run, support.explanation);
          if (
            root.state !== "pending" &&
            (!root.retry_scope || root.retry_scope !== support.retryScope)
          )
            return yield* markUnresolved(
              run,
              "Run conversation launch acceptance is unknown; replay continuity and retention are unproven.",
            );
          if (!intactPayload(root))
            return yield* markUnresolved(
              run,
              "Stored Run conversation payload cannot be verified.",
            );
          const payload = JSON.parse(root.payload_json) as LaunchPayload;
          if (
            payload.clientRequestId !== root.request_key ||
            payload.projectId !== run.t3_project_id ||
            payload.environmentId !== run.environment_id
          )
            return yield* markUnresolved(run, "Stored Run conversation target cannot be verified.");
          if (!(yield* reserve(run, root, support.retryScope))) return;
          const reference = yield* Effect.tryPromise(() =>
            t3.launchThread(runTarget(run), payload),
          );
          yield* acknowledge(run, reference);
        }),
        () =>
          markUnresolved(
            run,
            "Run conversation launch response is uncertain. No replacement conversation has been created.",
          ),
      );
    });
  }
  return { dispatch };
}

import { observeRootControl } from "./run-control-observation.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter, SendPayload } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
import { failure } from "./result.ts";
import { recoverOperation } from "./runner-effects.ts";

type Recovery = {
  run_id: string;
  source_execution_id: string;
  thread_id: string;
  activation_id: string | null;
  request_key: string;
  payload_json: string;
  retry_scope: string | null;
  state: string;
  acknowledgement_json: string | null;
};

function rootRecoveryFrontier(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  source: string,
) {
  return Effect.gen(function* () {
    const target = runTarget(run);
    const observation = yield* observeRootControl(database, t3, run, threadId);
    const queue = yield* Effect.tryPromise(() => t3.readQueue(target, threadId));
    const native = yield* Effect.tryPromise(() => t3.readNativeRequests(target, threadId));
    const activity = yield* Effect.tryPromise(() => t3.readDelegationActivity(target, threadId));
    if (
      !rootSourceCurrent(observation, run, threadId, source) ||
      queue.threadId !== threadId ||
      queue.queuedRunIds.length ||
      queue.nextCursor !== null ||
      native.threadId !== threadId ||
      native.projectId !== run.t3_project_id ||
      native.pendingRequestCount !== 0 ||
      observation.pendingRequestCount !== 0 ||
      activity.threadId !== threadId ||
      activity.projectId !== run.t3_project_id ||
      !activity.complete ||
      activity.problem
    )
      return null;
    return activity;
  });
}

export function openRunControlRecovery(database: RunnerDatabase, t3: T3Adapter) {
  function dispatch(run: RunRow, recovery: Recovery) {
    return recoverOperation(
      Effect.gen(function* () {
        if (recovery.state === "acknowledged") return;
        const current = yield* database.row(run.id);
        if (!current) return;
        if (!(yield* pendingControlProof(database, t3, current, recovery))) return;
        const support = yield* Effect.tryPromise(() => t3.inspectSendSupport(runTarget(run)));
        if (
          !support.supported ||
          (recovery.state !== "pending" &&
            (!recovery.retry_scope || recovery.retry_scope !== support.retryScope))
        )
          return;
        const reserved = yield* database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, current, true))) return false;
            const [unchanged] =
              yield* sql`SELECT id FROM runs WHERE id=${run.id} AND generation=${current.generation}`;
            if (!unchanged) return false;
            return (
              (yield* sql`UPDATE run_control_recoveries SET state='reserved',retry_scope=${support.retryScope} WHERE run_id=${run.id} AND source_execution_id=${recovery.source_execution_id} AND state=${recovery.state} RETURNING run_id`)
                .length === 1
            );
          }),
        );
        if (!reserved) return;
        const ack = yield* Effect.tryPromise(() =>
          t3.sendMessage(runTarget(run), JSON.parse(recovery.payload_json) as SendPayload),
        );
        if (ack.threadId !== recovery.thread_id || !ack.runId)
          throw Error("Recovery acknowledgement scope changed.");
        yield* database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            yield* sql`UPDATE run_control_recoveries SET state='acknowledged',acknowledgement_json=${JSON.stringify(ack)} WHERE run_id=${run.id} AND source_execution_id=${recovery.source_execution_id}`;
            if (recovery.activation_id)
              yield* sql`UPDATE run_coordinator_commands SET parent_execution_id=${ack.runId} WHERE activation_id=${recovery.activation_id} AND accepted_json IS NULL AND state='issued' AND parent_execution_id=${recovery.source_execution_id}`;
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          }),
        );
      }),
      () =>
        database.mutate(
          run.id,
          (sql) =>
            sql`UPDATE run_control_recoveries SET state='uncertain' WHERE run_id=${run.id} AND source_execution_id=${recovery.source_execution_id} AND state='reserved'`,
        ),
    );
  }
  function reconcile(run: RunRow) {
    return Effect.gen(function* () {
      const rows = yield* database.transaction(
        (sql) => sql<Recovery>`SELECT * FROM run_control_recoveries WHERE run_id=${run.id}`,
      );
      for (const recovery of rows) {
        if (recovery.state !== "acknowledged") {
          yield* dispatch(run, recovery);
          continue;
        }
        const ack = JSON.parse(recovery.acknowledgement_json!) as { runId: string };
        const observed = yield* observeRootControl(database, t3, run, recovery.thread_id);
        if (observed.threadId !== recovery.thread_id || observed.projectId !== run.t3_project_id)
          continue;
        if (!observed.recentRuns.some((e) => e.runId === ack.runId && e.status === "completed"))
          continue;
        yield* database.mutate(
          run.id,
          (sql) =>
            sql`UPDATE run_control_recoveries SET completed_execution_id=${ack.runId} WHERE run_id=${run.id} AND source_execution_id=${recovery.source_execution_id}`,
        );
      }
    });
  }
  function recoverRunCoordinator(runId: string, sourceExecutionId: string) {
    void runId;
    void sourceExecutionId;
    return Effect.succeed(
      failure(
        "conflict",
        "Factory no longer recovers a Run conversation. Each Block worker is launched directly.",
      ),
    );
  }
  return { recoverRunCoordinator, reconcile };
}

function pendingControlProof(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  recovery: Recovery,
) {
  return Effect.gen(function* () {
    if (recovery.state !== "pending") return true;
    const activity = yield* rootRecoveryFrontier(
      database,
      t3,
      run,
      recovery.thread_id,
      recovery.source_execution_id,
    );
    if (!activity) return false;
    if (!recovery.activation_id) return true;
    const [command] = yield* database.transaction(
      (sql) =>
        sql<{
          request_key: string;
        }>`SELECT request_key FROM run_coordinator_commands WHERE activation_id=${recovery.activation_id} AND state='issued' AND accepted_json IS NULL AND problem IS NULL AND parent_execution_id=${recovery.source_execution_id}`,
    );
    return (
      !!command &&
      !activity.invocations.some(
        (i) =>
          i.parentRunId === recovery.source_execution_id ||
          i.input.clientRequestId === command.request_key,
      ) &&
      !activity.followups?.some((i) => i.parentRunId === recovery.source_execution_id) &&
      !activity.remoteTasks?.some((i) => i.parentRunId === recovery.source_execution_id) &&
      !activity.taskResults?.some((i) => i.parentRunId === recovery.source_execution_id) &&
      !activity.commands?.some((i) => i.parentRunId === recovery.source_execution_id)
    );
  });
}

function rootSourceCurrent(
  observation: Awaited<ReturnType<T3Adapter["readExecution"]>>,
  run: RunRow,
  threadId: string,
  source: string,
) {
  const failed = observation.recentRuns.find((e) => e.runId === source);
  return (
    observation.threadId === threadId &&
    observation.projectId === run.t3_project_id &&
    (observation.workspaceRoot === null || observation.workspaceRoot === run.workspace_root) &&
    !observation.activeRunId &&
    failed !== undefined &&
    ["failed", "cancelled", "interrupted"].includes(failed.status) &&
    failed.ordinal !== undefined &&
    !observation.recentRuns.some(
      (e) => e.ordinal === undefined || (e.ordinal > failed.ordinal! && e.status !== "completed"),
    )
  );
}

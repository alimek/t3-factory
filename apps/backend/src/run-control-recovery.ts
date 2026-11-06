import { observeRootControl } from "./run-control-observation.ts";
import * as Effect from "effect/Effect";
import { recoveredRootFailures } from "./run-control-recovery-proof.ts";
import type { T3Adapter, SendPayload } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow, RunnerLifecycle } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
import { newId } from "./ids.ts";
import { failure } from "./result.ts";
import { recoverOperation } from "./runner-effects.ts";
import { rootCommandMessage } from "./run-coordinator-commands.ts";

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

export function openRunControlRecovery(
  database: RunnerDatabase,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
) {
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
    return Effect.gen(function* () {
      const run = yield* database.row(runId);
      if (!run) return failure("conflict", "This Run has no control recovery authority.");
      const recovered = yield* database.transaction((sql) => recoveredRootFailures(sql, runId));
      if (recovered.some((r) => r.executionId === sourceExecutionId))
        return yield* lifecycle.getRun(runId);
      const owned = yield* database.transaction(
        (sql) =>
          sql`SELECT run_id FROM run_coordinators WHERE run_id=${runId} AND execution_id=${sourceExecutionId} UNION SELECT run_id FROM run_coordinator_commands WHERE run_id=${runId} AND parent_execution_id=${sourceExecutionId} UNION SELECT run_id FROM run_control_recoveries WHERE run_id=${runId} AND json_extract(acknowledgement_json,'$.runId')=${sourceExecutionId}`,
      );
      if (!owned.length)
        return failure("conflict", "This execution has no Factory control authority.");
      const [prior] = yield* database.transaction(
        (sql) =>
          sql<Recovery>`SELECT * FROM run_control_recoveries WHERE run_id=${runId} AND source_execution_id=${sourceExecutionId}`,
      );
      if (prior) {
        yield* dispatch(run, prior);
        return yield* lifecycle.getRun(runId);
      }
      const [root] = yield* database.transaction(
        (sql) =>
          sql<{
            thread_id: string;
          }>`SELECT thread_id FROM run_coordinators WHERE run_id=${runId} AND state='acknowledged'`,
      );
      if (!root?.thread_id || !run.gate_open || run.closed_at)
        return failure(
          "conflict",
          "Run control recovery requires an open acknowledged primary conversation.",
        );
      const activity = yield* recoverOperation(
        rootRecoveryFrontier(database, t3, run, root.thread_id, sourceExecutionId),
        () => Effect.succeed(null),
      );
      if (!activity)
        return failure(
          "conflict",
          "Fresh exact failed, cancelled or interrupted execution, queue and native evidence is required.",
        );
      const commands = yield* database.transaction(
        (sql) =>
          sql<{
            activation_id: string;
            invocation_json: string;
            accepted_json: string | null;
            state: string;
            problem: string | null;
          }>`SELECT activation_id,invocation_json,accepted_json,state,problem FROM run_coordinator_commands WHERE run_id=${runId} AND parent_execution_id=${sourceExecutionId}`,
      );
      const retainedNative = yield* database.transaction(
        (sql) =>
          sql`SELECT source_key FROM run_coordinator_obligations WHERE run_id=${runId} AND json_extract(evidence_json,'$.parentRunId')=${sourceExecutionId}`,
      );
      const unissued = commands.filter((c) => c.state === "issued" && c.accepted_json === null);
      if (
        unissued.length > 1 ||
        unissued.some((c) => c.problem !== null) ||
        (unissued.length > 0 && retainedNative.length > 0) ||
        (unissued.length > 0 && sourceHasNativeWork(activity, sourceExecutionId))
      )
        return failure(
          "conflict",
          "Issued or uncertain native work cannot be replayed or rebound.",
        );
      const key = yield* newId;
      const payload: SendPayload = {
        environmentId: run.environment_id,
        threadId: root.thread_id,
        mode: "queue",
        clientRequestId: key,
        message:
          "Explicit Factory control recovery. Preserve all accepted Block results; do not repeat or replace issued work. " +
          (unissued[0]
            ? rootCommandMessage(JSON.parse(unissued[0].invocation_json))
            : "No new Block work is authorized. Read current Factory context and end this turn."),
      };
      const accepted = yield* database.mutate(runId, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
          const [current] = yield* sql<{
            generation: number;
          }>`SELECT generation FROM runs WHERE id=${runId}`;
          if (current?.generation !== run.generation) return false;
          yield* sql`INSERT INTO run_control_recoveries(run_id,source_execution_id,thread_id,activation_id,request_key,payload_json) VALUES(${runId},${sourceExecutionId},${root.thread_id},${unissued[0]?.activation_id ?? null},${key},${JSON.stringify(payload)}) ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runId}`;
          return true;
        }),
      );
      if (!accepted)
        return failure("conflict", "Run changed before control recovery was accepted.");
      yield* reconcile(run);
      return yield* lifecycle.getRun(runId);
    });
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

function sourceHasNativeWork(
  activity: Awaited<ReturnType<T3Adapter["readDelegationActivity"]>>,
  executionId: string,
) {
  return [
    ...activity.invocations,
    ...(activity.followups ?? []),
    ...(activity.remoteTasks ?? []),
    ...(activity.taskResults ?? []),
    ...(activity.commands ?? []),
  ].some((i) => i.parentRunId === executionId);
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

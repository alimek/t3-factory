import { openRootSettlement } from "./run-root-settlement.ts";
import { rootUnavailable } from "./run-root-ledger.ts";
import { rootFrontier } from "./run-root-frontier.ts";

import { openCoordinatorQuestionReplies } from "./coordinator-question-reply.ts";
import { openRunControlRecovery } from "./run-control-recovery.ts";
import { openBlockTools } from "./runner-block-tools.ts";
import { openRuntimeContext } from "./runtime-context.ts";
import { openRootCommands } from "./run-coordinator-commands.ts";
import { openRunCoordinator } from "./run-coordinator.ts";
import { openRunnerRecovery } from "./runner-recovery.ts";
import { settleRecoveries } from "./runner-recovery-settlement.ts";
import { openRunPresentation } from "./run-presentation.ts";
import { openRunNavigation } from "./run-navigation.ts";
import type { FactoryOperations, Result } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { EffectOperations } from "./effect-operations.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import { failure } from "./result.ts";
import type { BlockRow, IntentRow, RunnerOptions, RunRow } from "./runner-types.ts";
import type { RuntimeBinding } from "./runtime-types.ts";
import { openRunnerDatabase } from "./runner-database.ts";
import { openRunnerDispatch } from "./runner-dispatch.ts";
import { openRunnerHuman } from "./runner-human.ts";
import { openRunnerObservation } from "./runner-observation.ts";
import { openRunnerQueries } from "./runner-queries.ts";
import { openRunnerReports } from "./runner-reports.ts";
import { openRunnerStart } from "./runner-start.ts";
import { openRunnerStop } from "./runner-stop.ts";
import { makeRunLanes } from "./runner-lanes.ts";
import { recoverOperation } from "./runner-effects.ts";

/** One scoped Runner owner. Accepted work drains before SQL and ownership are released. */
export const makeRunner = Effect.fn("Runner.make")(function* (
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  owner: { token: string },
  bindings: RunnerOptions["bindings"],
  intervalMs: number,
  checkAgent: RunnerOptions["checkAgent"],
) {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const database = openRunnerDatabase(sql, owner);
  const { row } = database;
  const rootCommands = openRootCommands(database, t3);
  const runCoordinator = openRunCoordinator(database, t3);
  const { getRun, listTasks, updateTask, reportBindings, isClosedThread, listAttention } =
    openRunnerQueries(database);
  let closed = false;
  const starts = Semaphore.makeUnsafe(1);
  const sweeps = Semaphore.makeUnsafe(1);
  const closing = Semaphore.makeUnsafe(1);
  const drives = makeRunLanes();
  const detached = new Set<Fiber.Fiber<unknown, unknown>>();
  let timer: Fiber.Fiber<never, unknown> | undefined;
  const fork = Effect.fn("Runner.fork")(function* (work: Effect.Effect<unknown, unknown>) {
    if (closed) return;
    const fiber = yield* Effect.forkIn(work.pipe(Effect.uninterruptible), scope);
    detached.add(fiber);
    fiber.addObserver(() => detached.delete(fiber));
  });
  const lifecycle = { isClosed: () => closed, drive, fork, getRun };
  const rootRecovery = openRunControlRecovery(database, t3);
  const { consumeRuntimeReport } = openRunnerReports(database, lifecycle, t3);
  const { observe } = openRunnerObservation(database, t3, bindings);
  const { dispatchIntent } = openRunnerDispatch(database, ops, t3, checkAgent, observe);
  const { start } = openRunnerStart(database, ops, t3, lifecycle, checkAgent);
  const { answerHumanOccurrence } = openRunnerHuman(database, lifecycle);
  const { stopRun, reconcileStop, stopObservationsUnavailable, attemptSuccessfulClosure } =
    openRunnerStop(database, t3, lifecycle, liveContextId);
  const { settleRoot } = openRootSettlement(database, t3, lifecycle, liveContextId);

  function drive(
    id: string,
    phase: "observe" | "dispatch" | "both" = "both",
  ): Effect.Effect<void, unknown> {
    return drives.serial(id, () => driveWork(id, phase));
  }
  function liveContextId() {
    return Effect.gen(function* () {
      const connection = yield* ops.recheckConnection();
      return connection.ok && connection.value.state === "ready"
        ? (connection.value.authorizationContext?.id ?? null)
        : null;
    });
  }
  function driveWork(id: string, phase: "observe" | "dispatch" | "both") {
    return Effect.gen(function* () {
      const runRow = yield* row(id);
      if (!runRow || runRow.closed_at) return;
      const contextId = yield* liveContextId();
      yield* driveRootWork(runRow, contextId, phase);
      yield* driveBlockWork(runRow, contextId, phase);
    });
  }
  function driveRootWork(
    rootRun: RunRow,
    contextId: string | null,
    phase: "observe" | "dispatch" | "both",
  ) {
    return Effect.gen(function* () {
      if (phase !== "observe") yield* runCoordinator.dispatch(rootRun, contextId);
      if (contextId === rootRun.context_id)
        yield* recoverOperation(rootRecovery.reconcile(rootRun), () => Effect.void);
      if (phase !== "dispatch" && contextId === rootRun.context_id) {
        yield* recoverOperation(rootFrontier(database, t3, rootRun).pipe(Effect.asVoid), () =>
          rootUnavailable(database, rootRun.id),
        );
        yield* rootCommands.observe(rootRun);
      }
      if (phase !== "observe" && contextId === rootRun.context_id)
        yield* rootCommands.dispatch(rootRun);
    });
  }
  function driveBlockWork(
    runRow: RunRow,
    contextId: string | null,
    phase: "observe" | "dispatch" | "both",
  ) {
    return Effect.gen(function* () {
      const id = runRow.id;
      const blocks =
        yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${id} AND thread_id IS NOT NULL`;
      if (runRow.gate_open && phase !== "dispatch")
        for (const block of blocks) yield* observe((yield* row(id))!, block, contextId);
      yield* settleRecoveries(database, lifecycle, t3, id);
      if (phase === "observe") return;
      const intents =
        yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${id} AND state IN ('pending','reserved','uncertain') ORDER BY rowid`;
      for (const intent of intents) {
        if (closed) break;
        yield* dispatchIntent(runRow, intent, contextId);
      }
      const stopping = yield* row(id);
      if (!stopping?.stop_requested_at || stopping.closed_at) return;
      if (contextId === stopping.context_id) yield* reconcileStop(stopping);
      else yield* stopObservationsUnavailable(stopping.id);
    });
  }
  const reconcileRuns = Effect.fn("Runner.reconcile")(function* (): Effect.fn.Return<
    Result<void>,
    unknown
  > {
    if (closed) return failure("conflict", "Factory is shutting down.");
    return yield* sweeps
      .withPermit(
        Effect.gen(function* () {
          if (closed) return failure("conflict", "Factory is shutting down.");
          const ids = yield* sql<{
            id: string;
          }>`SELECT id FROM runs WHERE closed_at IS NULL OR EXISTS(SELECT 1 FROM run_root_settlements s WHERE s.run_id=runs.id AND s.attempted_at IS NULL AND s.retired_at IS NULL) ORDER BY started_at,id`;
          // Restart observes every Run before dispatching any pending intent.
          yield* Effect.forEach(ids, (run) => drive(run.id, "observe"), {
            concurrency: "unbounded",
          });
          yield* Effect.forEach(ids, (run) => drive(run.id, "dispatch"), {
            concurrency: "unbounded",
          });
          yield* Effect.forEach(ids, (run) => attemptSuccessfulClosure(run.id), {
            concurrency: "unbounded",
          });
          yield* Effect.forEach(ids, (run) => settleRoot(run.id), { concurrency: "unbounded" });
          return { ok: true as const, value: undefined };
        }),
      )
      .pipe(Effect.uninterruptible);
  });
  const close = () =>
    closing
      .withPermit(
        Effect.gen(function* () {
          if (closed) return;
          closed = true;
          if (timer) yield* Fiber.interrupt(timer);
          yield* starts.withPermit(Effect.void);
          yield* sweeps.withPermit(Effect.void);
          yield* Fiber.awaitAll(detached);
          yield* drives.drain();
          yield* database.drain();
        }),
      )
      .pipe(Effect.uninterruptible);
  yield* Effect.addFinalizer(close);
  return {
    ...openRunnerRecovery(database, lifecycle, t3, liveContextId),
    recoverRunCoordinator: rootRecovery.recoverRunCoordinator,
    readFactoryTool: openBlockTools(database, t3, getRun, liveContextId),
    runtimeContext: openRuntimeContext(
      database,
      t3,
      rootCommands,
      observe,
      drives.serial,
      liveContextId,
      getRun,
    ),
    reportBindings: (key: string, threadId?: string, discover = false) =>
      Effect.gen(function* () {
        if (!discover) return yield* reportBindings(key, threadId);
        const known = threadId
          ? yield* sql`SELECT run_id FROM run_blocks WHERE thread_id=${threadId}`
          : [];
        const pending = known.length
          ? []
          : yield* sql<{
              id: string;
            }>`SELECT r.id FROM runs r WHERE r.closed_at IS NULL AND r.gate_open=1 AND EXISTS(SELECT 1 FROM run_coordinator_commands c WHERE c.run_id=r.id AND c.state='issued')`;
        for (const candidate of pending) yield* drive(candidate.id, "observe");
        return yield* reportBindings(key, threadId);
      }),
    isClosedThread,
    answerHumanOccurrence,
    replyCoordinatorQuestion: openCoordinatorQuestionReplies(database, lifecycle),
    stopRun,
    ...openRunNavigation(database, getRun),
    ...openRunPresentation(database),
    getRun,
    listAttention,
    getRunCreationPolicy: () =>
      Effect.succeed({ ok: true as const, value: { ready: true as const } }),
    startRun: (input: unknown) => starts.withPermit(start(input)).pipe(Effect.uninterruptible),
    listRuns: (projectId: string) =>
      Effect.gen(function* () {
        const list = yield* listTasks(projectId);
        if (!list.ok) return list;
        return {
          ok: true as const,
          value: list.value.flatMap((task) =>
            task.runs.map((run) => ({
              id: run.id,
              task: { id: task.id, title: task.title, projectId: task.projectId },
              flowId: run.flowId,
              flowName: run.flowName,
              startedAt: run.startedAt,
              closedAt: run.closedAt,
              outcome: run.outcome,
              stopRequestedAt: run.stopRequestedAt,
            })),
          ),
        };
      }),
    listTasks,
    updateTask,
    reconcileRuns,
    initialize: () =>
      Effect.gen(function* () {
        yield* database.initialize();
        yield* reconcileRuns();
        timer = yield* Effect.forkIn(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(intervalMs);
              yield* recoverOperation(reconcileRuns(), () => Effect.void);
            }),
          ),
          scope,
        );
      }),
    refreshRuntimeBinding: (binding: RuntimeBinding) =>
      Effect.gen(function* () {
        if (closed) return;
        const run = yield* row(binding.factoryRunId);
        if (run && !run.closed_at && run.gate_open) yield* drive(run.id, "observe");
      }),
    consumeRuntimeReport,
    close,
  };
});

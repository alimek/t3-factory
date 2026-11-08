import { openBlockTools } from "./runner-block-tools.ts";
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
import { openRunnerDatabase } from "./runner-database.ts";
import { openRunnerDispatch } from "./runner-dispatch.ts";
import { openRunnerHuman } from "./runner-human.ts";
import { openRunnerObservation } from "./runner-observation.ts";
import { openRunnerQueries } from "./runner-queries.ts";
import { openRunnerReports } from "./runner-reports.ts";
import { openRunnerStart } from "./runner-start.ts";
import { openRunnerArchive } from "./runner-archive.ts";
import { openRunnerSettle } from "./runner-settle.ts";
import { makeRunLanes } from "./runner-lanes.ts";
import { recoverOperation } from "./runner-effects.ts";
import type { LiveChanges } from "./live-changes.ts";

/** One scoped Runner owner. Accepted work drains before SQL and ownership are released. */
export const makeRunner = Effect.fn("Runner.make")(function* (
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  owner: { token: string },
  intervalMs: number,
  checkAgent: RunnerOptions["checkAgent"],
  changes: LiveChanges,
) {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const database = openRunnerDatabase(sql, owner, changes);
  const { row } = database;
  const { getRun, listTasks, updateTask, listAttention } = openRunnerQueries(database);
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
  const { consumeBlockUpdate } = openRunnerReports(database, lifecycle);
  const { observe } = openRunnerObservation(database, t3);
  const { dispatchIntent } = openRunnerDispatch(database, ops, t3, checkAgent, observe);
  const { start } = openRunnerStart(database, ops, t3, lifecycle, checkAgent);
  const { answerHumanOccurrence } = openRunnerHuman(database, lifecycle);
  const { archiveRun } = openRunnerArchive(database, t3, lifecycle, liveContextId);
  const { settleRun, settleWhenDone } = openRunnerSettle(database, t3, lifecycle, liveContextId);

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
      if (!runRow || runRow.archived_at) return;
      const contextId = yield* liveContextId();
      yield* driveBlockWork(runRow, contextId, phase);
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
      const observed = (yield* row(id)) ?? runRow;
      yield* dispatchIntents(observed, contextId);
      // Binding the Run worktree during dispatch records the launches that join it.
      const current = yield* row(id);
      if (preparing(observed) && current && !preparing(current))
        yield* dispatchIntents(current, contextId);
    });
  }
  function dispatchIntents(runRow: RunRow, contextId: string | null) {
    return Effect.gen(function* () {
      const intents =
        yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${runRow.id} AND state IN ('pending','reserved','uncertain') ORDER BY rowid`;
      for (const intent of intents) {
        if (closed) break;
        yield* dispatchIntent(runRow, intent, contextId);
      }
    });
  }
  const preparing = ({ workspace }: RunRow) =>
    workspace.mode === "worktree" && workspace.state === "preparing";
  const reconcileRuns = Effect.fn("Runner.reconcile")(function* (): Effect.fn.Return<
    Result<void>,
    unknown
  > {
    if (closed) return failure("conflict", "Factory is shutting down.");
    return yield* sweeps
      .withPermit(
        Effect.gen(function* () {
          if (closed) return failure("conflict", "Factory is shutting down.");
          // A Settled Run is driven only while it still owes an operation, so its work continues.
          const ids = yield* sql<{
            id: string;
          }>`SELECT id FROM runs WHERE archived_at IS NULL AND (settled_at IS NULL OR EXISTS(SELECT 1 FROM operation_intents i WHERE i.run_id=runs.id AND i.state IN ('pending','reserved','uncertain'))) ORDER BY started_at,id`;
          // Restart observes every Run before dispatching any pending intent.
          yield* Effect.forEach(ids, (run) => drive(run.id, "observe"), {
            concurrency: "unbounded",
          });
          yield* Effect.forEach(ids, (run) => drive(run.id, "dispatch"), {
            concurrency: "unbounded",
          });
          yield* Effect.forEach(ids, (run) => settleWhenDone(run.id), {
            concurrency: "unbounded",
          });
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
    readFactoryTool: openBlockTools(database, getRun),
    answerHumanOccurrence,
    archiveRun,
    settleRun,
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
              lifecycle: run.lifecycle,
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
    consumeBlockUpdate,
    close,
  };
});

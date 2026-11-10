import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunStore } from "./runner/run-store/run-store.ts";
import { changeLifecycle } from "./run-lifecycle.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { recoverOperation } from "./runner-effects.ts";
import { runTarget } from "./runner-utils.ts";
import { readWorkerThread } from "./worker-thread.ts";

export function openRunnerSettle(
  store: RunStore,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  /** A worker thread T3 cannot read now keeps the Run Active until a later sweep. */
  function threadsFinished(run: RunRow, threads: readonly string[]) {
    return recoverOperation(
      Effect.gen(function* () {
        for (const thread of threads)
          if (!(yield* Effect.tryPromise(() => readWorkerThread(t3, run, thread))).finished)
            return false;
        return true;
      }),
      () => Effect.succeed(false),
    );
  }

  /** Automatic settlement: every visited Block has its result, nothing is pending locally, no Human
   * occurrence is open and a fresh read finds every worker thread finished. */
  function settleWhenDone(id: string) {
    return Effect.gen(function* () {
      const run = yield* store.readRun(id);
      if (!run || run.archived_at || run.settled_at || !run.gate_open) return;
      const threads = yield* store.reportedBlockThreads(run.id);
      if (!threads || !(yield* threadsFinished(run, threads))) return;
      if ((yield* liveContextId()) !== run.context_id) return;
      if (yield* store.settleAutomatically(run)) yield* settleWorkerThreads(run);
    });
  }

  /** Requests native settlement of a worker thread whose T3 run the Run store claimed. */
  function requestThreadSettlement(run: RunRow, threadId: string) {
    return recoverOperation(
      Effect.tryPromise(() => t3.settleThread(runTarget(run), { threadId })),
      () => Effect.void,
    );
  }

  /** Settles worker threads whose Blocks already have a confirmed finished result while the Run continues. */
  function settleFinishedBlockThreads(id: string) {
    return Effect.gen(function* () {
      const run = yield* store.readRun(id);
      if (!run || run.archived_at) return;
      const support = yield* Effect.tryPromise(() =>
        t3.inspectSettleSupport(runTarget(run)).catch(() => null),
      );
      if (!support?.supported) return;
      const candidates = yield* store.threadSettlementCandidates(run.id);
      for (const candidate of candidates) {
        const ready = yield* recoverOperation(
          Effect.tryPromise(async () => {
            const worker = await readWorkerThread(t3, run, candidate.thread_id);
            return worker.finished && worker.latest?.runId === candidate.execution_id;
          }),
          () => Effect.succeed(false),
        );
        if (!ready) continue;
        if ((yield* liveContextId()) !== run.context_id) continue;
        if (yield* store.claimBlockThreadSettlement(run, candidate))
          yield* requestThreadSettlement(run, candidate.thread_id);
      }
    });
  }

  /** Best-effort native organization of a Settled Run's worker threads. A possibly issued
   * settlement is never replayed for the same run of a thread, so a manual reopen in T3 is
   * preserved; Factory never unsettles. */
  function settleWorkerThreads(run: RunRow) {
    return Effect.gen(function* () {
      const support = yield* Effect.tryPromise(() =>
        t3.inspectSettleSupport(runTarget(run)).catch(() => null),
      );
      if (!support?.supported) return;
      const threads = yield* store.settledRunThreads(run.id);
      for (const thread of threads) {
        if ((yield* liveContextId()) !== run.context_id) continue;
        if (
          yield* store.claimSettledRunThreadSettlement(run, thread.thread_id, thread.execution_id)
        )
          yield* requestThreadSettlement(run, thread.thread_id);
      }
    });
  }

  /** The user settles an Active or Snoozed Run at any time. Work already in progress continues;
   * Factory settles the worker threads in T3 in the background. */
  function settleRun(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    return changeLifecycle(
      lifecycle,
      id,
      store.settleManually(id),
      recoverOperation(
        Effect.flatMap(store.readRun(id), (run) => (run ? settleWorkerThreads(run) : Effect.void)),
        () => Effect.void,
      ),
    );
  }

  return { settleRun, settleWhenDone, settleFinishedBlockThreads };
}

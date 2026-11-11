import type {
  Result,
  RunSettlementOutcome,
  RunSettlementWorker,
  SettleRunInput,
} from "@t3-factory/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import { failure } from "../result.ts";
import { threadHref } from "../thread-link.ts";
import type { BoundWorker, RunStore, SettlementWorkerRecord } from "./run-store/run-store.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { recoverOperation } from "./runner-effects.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { readWorkerThread, type WorkerThread } from "./worker-thread.ts";

/** How long a worker whose Stop T3 acknowledged may stay unfinished before it is unresolved. */
const STOP_CONFIRMATION_MS = 30_000;

/** A fresh, correctly scoped read of a bound worker thread for manual settlement. */
type SettlementRead =
  | { readonly finished: true; readonly latest: WorkerThread["latest"] }
  | {
      readonly finished: false;
      readonly latest: WorkerThread["latest"];
      /** False when T3 could not show the thread in the Run's scope: Factory never stops it. */
      readonly readable: boolean;
      readonly problem: string;
    };

const UNREADABLE: SettlementRead = {
  finished: false,
  latest: null,
  readable: false,
  problem: "T3 could not show this worker thread in the Run's project and workspace.",
};
const CONTEXT_UNAVAILABLE: SettlementRead = {
  finished: false,
  latest: null,
  readable: false,
  problem: "The T3 connection is unavailable or its authorization changed.",
};

/** A plain object whose only allowed field is an optional boolean `stopWorkers`: a misspelled or
 * misplaced authorization flag is a validation error, never a declined Settle. */
function validSettleInput(input: unknown): input is SettleRunInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const { stopWorkers, ...rest } = input as Record<string, unknown>;
  return (
    !Object.keys(rest).length && (stopWorkers === undefined || typeof stopWorkers === "boolean")
  );
}

/** What still keeps an unfinished worker thread from counting as finished. */
function blocker(worker: WorkerThread) {
  const { thread } = worker;
  if (thread.activeRunId) return "T3 shows a run in progress.";
  if (thread.pendingRequestCount > 0) return "A native request is waiting in T3.";
  if (thread.recentRuns.some((run) => run.status === "queued"))
    return "T3 holds a queued run for this thread; remove it in T3 or let it run.";
  if (!worker.latest) return "T3 shows no run for this thread yet.";
  return "T3 has not confirmed that its delegated or background work settled.";
}

/** A worker's progress in the current attempt from its fresh read and its Stop record. */
function progress(read: SettlementRead, stop: SettlementWorkerRecord | undefined, time: number) {
  if (read.finished) return { state: "finished" as const, problem: null };
  if (stop?.stop_outcome === "acknowledged") {
    const waited = time - Date.parse(stop.stop_requested_at ?? "");
    return waited < STOP_CONFIRMATION_MS
      ? { state: "stopping" as const, problem: read.problem }
      : { state: "unresolved" as const, problem: `T3 acknowledged Stop, but ${read.problem}` };
  }
  if (stop?.stop_outcome) return { state: "unresolved" as const, problem: stop.stop_problem };
  if (stop?.stop_key)
    return {
      state: "unresolved" as const,
      problem: "Factory restarted while requesting Stop, so its outcome is unknown.",
    };
  return { state: "unresolved" as const, problem: read.problem };
}

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

  /** Factory's completion rule, plus no queued run, read in the Run's project and workspace. */
  function readForSettlement(run: RunRow, threadId: string) {
    return recoverOperation(
      Effect.tryPromise(async (): Promise<SettlementRead> => {
        const worker = await readWorkerThread(t3, run, threadId);
        const queued = worker.thread.recentRuns.some((entry) => entry.status === "queued");
        return worker.finished && !queued
          ? { finished: true, latest: worker.latest }
          : { finished: false, latest: worker.latest, readable: true, problem: blocker(worker) };
      }),
      () => Effect.succeed(UNREADABLE),
    );
  }

  /** Fresh reads of every bound worker, under the Run's live authorization context. */
  function readWorkers(run: RunRow, workers: readonly BoundWorker[]) {
    return Effect.gen(function* () {
      const live = !workers.length || (yield* liveContextId()) === run.context_id;
      const reads = new Map<string, SettlementRead>();
      for (const worker of workers)
        reads.set(
          worker.thread_id,
          live ? yield* readForSettlement(run, worker.thread_id) : CONTEXT_UNAVAILABLE,
        );
      return reads;
    });
  }

  /** One T3 thread Stop per unfinished worker of the attempt, each recorded before it is sent and
   * only under the Run's live authorization context, rechecked for every Stop. Stop is
   * thread-scoped, covers delegated work and has no run fence. */
  function requestStops(
    run: RunRow,
    attempt: number,
    workers: readonly BoundWorker[],
    reads: ReadonlyMap<string, SettlementRead>,
  ) {
    return Effect.gen(function* () {
      const support = yield* recoverOperation(
        Effect.tryPromise(() => t3.inspectStopSupport(runTarget(run))),
        () => Effect.succeed(null),
      );
      // A probe that could not run is not a Stop T3 refused: every worker keeps its Stop
      // eligibility for a later pass of the same attempt.
      if (!support) return false;
      for (const worker of workers) {
        if (!support.supported) {
          yield* store.recordStopOutcome(
            run,
            attempt,
            worker,
            "unsupported",
            `T3 cannot stop worker threads: ${support.explanation}`,
          );
          continue;
        }
        if ((yield* liveContextId()) !== run.context_id) {
          yield* store.recordStopOutcome(
            run,
            attempt,
            worker,
            "failed",
            "The T3 connection is unavailable or its authorization changed, so Factory did not request Stop.",
          );
          continue;
        }
        const key = fingerprint(`${run.id}:settle:${attempt}:${worker.thread_id}`);
        const executionId = reads.get(worker.thread_id)?.latest?.runId ?? null;
        if (!(yield* store.claimWorkerStop(run, attempt, worker, { key, executionId }))) continue;
        const sent = yield* recoverOperation(
          Effect.as(
            Effect.tryPromise(() =>
              t3.stopThread(runTarget(run), { threadId: worker.thread_id, clientRequestId: key }),
            ),
            true,
          ),
          () => Effect.succeed(false),
        );
        yield* store.recordStopOutcome(
          run,
          attempt,
          worker,
          sent ? "acknowledged" : "failed",
          sent ? null : "T3 did not accept the Stop request.",
        );
      }
      return true;
    });
  }

  /** Stops `stops` and reads each again, keeping a failed support check visible on the worker. */
  function stopAndReread(
    run: RunRow,
    attempt: number,
    stops: readonly BoundWorker[],
    reads: Map<string, SettlementRead>,
  ) {
    return Effect.gen(function* () {
      const probed = yield* requestStops(run, attempt, stops, reads);
      for (const worker of stops) {
        const read = yield* readForSettlement(run, worker.thread_id);
        reads.set(
          worker.thread_id,
          probed || read.finished
            ? read
            : {
                ...read,
                problem:
                  "T3 Stop support could not be checked, so Factory retries Stop on a later pass.",
              },
        );
      }
    });
  }

  /** Settles `run` once every bound worker read finished, cancelling its owed work, then
   * best-effort settles its worker threads in T3. */
  function complete(
    run: RunRow,
    workers: readonly BoundWorker[],
    reads: ReadonlyMap<string, SettlementRead>,
  ) {
    return Effect.gen(function* () {
      const settled = yield* store.completeSettlement(
        run,
        workers.map((worker) => {
          const latest = reads.get(worker.thread_id)?.latest ?? null;
          return {
            blockId: worker.block_id,
            threadId: worker.thread_id,
            executionId: latest?.runId ?? null,
            engineStatus: latest?.status ?? null,
          };
        }),
      );
      if (settled)
        yield* lifecycle.fork(
          recoverOperation(
            Effect.flatMap(store.readRun(run.id), (row) =>
              row ? settleWorkerThreads(row) : Effect.void,
            ),
            () => Effect.void,
          ),
        );
      return settled;
    });
  }

  /**
   * One pass of a confirmed manual settlement, in the Run's drive lane. Its gate is already
   * closed. Every bound worker is read fresh; the backend that accepted the attempt stops each
   * readable unfinished worker once and reads it again. Unreadable workers keep their Stop
   * eligibility for later passes; a worker bound later by a launch search joins the attempt.
   * Once a pass reads every worker finished and no launch outcome is unresolved, the Run settles; otherwise each
   * worker's progress is recorded, and a worker that cannot be stopped or confirmed stays
   * unresolved until the user retries.
   */
  function advanceSettlement(id: string) {
    return lifecycle.serial(id, () =>
      recoverOperation(
        Effect.gen(function* () {
          const run = yield* store.readRun(id);
          if (!run || run.archived_at || run.settled_at || run.gate_open) return;
          const operation = yield* store.readSettlementAttempt(id);
          if (!operation) return;
          const workers = yield* store.boundWorkers(id);
          const reads = yield* readWorkers(run, workers);
          const stoppable = workers.filter((worker) => {
            const read = reads.get(worker.thread_id)!;
            return !read.finished && read.readable;
          });
          const stops =
            stoppable.length && (yield* store.claimStopPass(run, operation.attempt))
              ? stoppable
              : operation.owned
                ? stoppable.filter(
                    (worker) =>
                      !operation.workers.some(
                        (record) =>
                          record.thread_id === worker.thread_id &&
                          (record.stop_key !== null || record.stop_outcome !== null),
                      ),
                  )
                : [];
          if (stops.length) yield* stopAndReread(run, operation.attempt, stops, reads);
          const launchesResolved = !(yield* store.unresolvedLaunches(id)).length;
          if (
            launchesResolved &&
            workers.every((worker) => reads.get(worker.thread_id)!.finished) &&
            (yield* complete(run, workers, reads))
          )
            return;
          const records = (yield* store.readSettlementAttempt(id))?.workers ?? [];
          const time = yield* Clock.currentTimeMillis;
          yield* store.recordSettlementProgress(
            run,
            operation.attempt,
            workers.map((worker) => ({
              ...worker,
              ...progress(
                reads.get(worker.thread_id)!,
                records.find((record) => record.thread_id === worker.thread_id),
                time,
              ),
            })),
          );
        }),
        () => Effect.void,
      ),
    );
  }

  /** The answer for the Run as it now is, after a confirmed or repeated Settle. */
  function currentOutcome(id: string) {
    return Effect.gen(function* (): Effect.fn.Return<Result<RunSettlementOutcome>, unknown> {
      const detail = yield* lifecycle.getRun(id);
      if (!detail.ok) return detail;
      const run = detail.value;
      if (run.lifecycle === "settled") return { ok: true, value: { outcome: "settled", run } };
      if (run.settlement) return { ok: true, value: { outcome: run.settlement.state, run } };
      return failure("conflict", "The Run changed while Factory settled it. Settle again.");
    });
  }

  /** Settle without authorization to stop: it completes only when fresh reads, in the Run's
   * drive lane, confirm every bound worker finished; otherwise nothing changes. */
  function settleIfFinished(id: string) {
    return lifecycle.serial(id, () =>
      Effect.gen(function* (): Effect.fn.Return<Result<RunSettlementOutcome>, unknown> {
        const run = yield* store.readRun(id);
        if (!run) return failure("not_found", "This Run does not exist.");
        if (run.archived_at || run.settled_at || !run.gate_open) return yield* currentOutcome(id);
        const workers = yield* store.boundWorkers(id);
        const reads = yield* readWorkers(run, workers);
        const launches = yield* store.unresolvedLaunches(id);
        if (!launches.length && workers.every((worker) => reads.get(worker.thread_id)!.finished)) {
          // A report or answer accepted during the reads makes `complete` refuse; the user retries.
          yield* complete(run, workers, reads);
          return yield* currentOutcome(id);
        }
        const detail = yield* lifecycle.getRun(id);
        if (!detail.ok) return detail;
        return {
          ok: true,
          value: {
            outcome: "confirmation-required",
            run: detail.value,
            workers: [
              ...workers.map((worker): RunSettlementWorker => {
                const read = reads.get(worker.thread_id)!;
                return {
                  blockId: worker.block_id,
                  blockName: worker.name,
                  threadId: worker.thread_id,
                  link: threadHref(worker.link),
                  // Only a worker read running in scope is one confirming stops; Factory never
                  // stops a thread it cannot read.
                  state: read.finished ? "finished" : read.readable ? "executing" : "unresolved",
                  stopRequestedAt: null,
                  problem: read.finished ? null : read.problem,
                };
              }),
              ...launches,
            ],
          },
        };
      }),
    );
  }

  /**
   * Manual Settle of an Active or Snoozed Run. Without `stopWorkers` it settles only when fresh
   * reads confirm every bound worker finished. With it, the Run store closes the gate and records
   * the attempt before any Stop, the answer shows it stopping, and the first pass follows in the
   * background. Repeating Settle while stopping changes nothing; `stopWorkers` on an unresolved
   * settlement starts the next attempt.
   */
  function settleRun(
    id: string,
    input: unknown,
  ): Effect.Effect<Result<RunSettlementOutcome>, unknown> {
    return Effect.gen(function* () {
      if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
      if (!validSettleInput(input))
        return failure(
          "validation",
          "Send the Settle options as an object whose only field, stopWorkers, is true or false.",
        );
      const stopWorkers = input.stopWorkers === true;
      const run = yield* store.readRun(id);
      if (!run) return failure("not_found", "This Run does not exist.");
      if (run.archived_at) return failure("conflict", "An archived Run cannot be settled.");
      if (!stopWorkers) return yield* settleIfFinished(id);
      const accepted = yield* store.acceptSettlement(id);
      if (!accepted.ok) return accepted;
      const outcome = yield* currentOutcome(id);
      if (accepted.value) yield* lifecycle.fork(advanceSettlement(id));
      return outcome;
    });
  }

  return { settleRun, settleWhenDone, settleFinishedBlockThreads, advanceSettlement };
}

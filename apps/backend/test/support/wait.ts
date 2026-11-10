import type { TestContext } from "@effect/vitest";
import type { RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { FactoryService } from "../../src/index.ts";
import { recordLaunchedThread } from "./controlled-thread.ts";
import { prepared } from "./prepared-runner.ts";
import {
  resultReleasedToHumanReview,
  resultReported,
  workerAtWork,
  workerHandle,
  type ReadyFlowShape,
  type WorkerHandle,
} from "./scenarios.ts";

/*
 * Wait timing on backend services whose background fibers sleep on the test clock. A test's Flow
 * reaches its worker through the Promise facade; the backend then reopens on the test clock at
 * 09:00, with no periodic reconciliation inside the test's window, so only Factory's own wake-up
 * timer can forward a waiting arrival.
 */

type Service = FactoryService["Service"];
type Prepared = Awaited<ReturnType<typeof prepared>>;

/** The test clock's time when the backend reopens. */
const OPENED_AT = "2026-11-10T09:00:00.000Z";
const QUIET_MS = 365 * 24 * 60 * 60 * 1000;

/** `clock` (HH:MM) on the day the backend reopens, as Factory stores times. */
export const at = (clock: string) => `2026-11-10T${clock}:00.000Z`;
export const minutes = (count: number) => count * 60_000;

/** Opens the prepared home on test-clock services; `close` ends them so the home can reopen. */
export const openOnTestClock = (f: Prepared) =>
  f.h.closableService({ t3: f.t3, connectionRetryMs: QUIET_MS });

function reopenedAt0900(f: Prepared) {
  return Effect.gen(function* () {
    yield* Effect.promise(() => f.f.close());
    yield* TestClock.setTime(Date.parse(OPENED_AT));
    return yield* openOnTestClock(f);
  });
}

/** `shape`'s Entry worker at work, its backend reopened at 09:00 on the test clock. */
export function workerAtWorkOnTestClock(c: TestContext, shape: ReadyFlowShape) {
  return Effect.gen(function* () {
    const f = yield* Effect.promise(() => prepared(c, shape));
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    return { ...f, worker, ...(yield* reopenedAt0900(f)) };
  });
}

/** `shape`'s Entry worker reported its result and its turn ended; reopening at 09:00 on the test
 * clock released the result, so its message waits at the Wait after the worker from 09:00. */
export function resultWaiting(c: TestContext, shape: ReadyFlowShape) {
  return Effect.gen(function* () {
    const f = yield* Effect.promise(() => prepared(c, shape));
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    return { ...f, worker, ...(yield* reopenedAt0900(f)) };
  });
}

/** `shape`'s Entry worker reported its result and Factory released it to the Human review after
 * it; the backend then reopened at 09:00 on the test clock with that occurrence pending. */
export function reviewPendingOnTestClock(c: TestContext, shape: ReadyFlowShape) {
  return Effect.gen(function* () {
    const f = yield* Effect.promise(() => prepared(c, shape));
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    const review = yield* Effect.promise(async () =>
      resultReleasedToHumanReview(f.world, await resultReported(f.world, worker)),
    );
    return { ...f, worker, review, ...(yield* reopenedAt0900(f)) };
  });
}

/** The worker reports through Factory's report entry on the test-clock services. */
export function reportOn(
  factory: Service,
  worker: WorkerHandle,
  fields: {
    readonly to: "working" | "finished";
    readonly exit?: string;
    readonly message?: string;
  },
) {
  return Effect.map(
    factory.runtime.submit({ arguments: { blockId: worker.blockId, ...fields } }),
    (reply) => reply.code,
  );
}

export function runOn(factory: Service, runId: string) {
  return Effect.flatMap(factory.getRun(runId), (run) =>
    run.ok ? Effect.succeed(run.value) : Effect.die(Error(run.error.message)),
  );
}

/** The launched worker of `flowBlockId`, whose first turn T3 then shows running. */
export function launchedWorker(f: Prepared, run: RunDetail, flowBlockId: string) {
  return Effect.gen(function* () {
    const worker = workerHandle(f.world, run, flowBlockId);
    yield* Effect.promise(() => recordLaunchedThread(f.t3, worker.threadId));
    return worker;
  });
}

const WAKE_TURNS = 50;

/**
 * The Run once background work woken by the test clock has committed `until`. A woken drive awaits
 * the T3 adapter between store transitions, which the test clock does not track, so this yields
 * to it for a bounded number of turns. It never reconciles.
 */
export function runAfterWake(factory: Service, runId: string, until: (run: RunDetail) => boolean) {
  return Effect.gen(function* () {
    for (let turn = 0; turn < WAKE_TURNS; turn++) {
      const run = yield* runOn(factory, runId);
      if (until(run)) return run;
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return yield* runOn(factory, runId);
  });
}

export const arrivalStates = (run: RunDetail) => run.waitArrivals.map((arrival) => arrival.state);

export const blockState = (run: RunDetail, blockId: string) =>
  run.blocks.find((block) => block.blockId === blockId)?.state;

export const launchedBlock = (blockId: string) => (run: RunDetail) =>
  run.blocks.some((block) => block.blockId === blockId && block.threadId !== null);

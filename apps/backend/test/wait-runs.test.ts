import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { preparedService } from "./support/prepared-runner.ts";
import {
  allTurnsEnd,
  launchBlockId,
  observeFor,
  parallelWaitFlow,
  resultHeld,
  resultReleasedToWait,
  resultReported,
  twoWorkersStarted,
  WAIT_MINUTES,
  waitFlow,
  workerAtWork,
} from "./support/scenarios.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Leaves the periodic reconcile out of the clock, so only scheduled wake-ups advance work. */
const scheduledOnly = { connectionRetryMs: DAY };

it.effect(
  "a released result waits its duration, then reaches the next Agent unchanged without a Wait worker",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() =>
        resultReported(f.world, worker, { message: "Ready for the follow-up." }),
      );
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const followUpLaunch = f.t3.nextLaunch();

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const launched = yield* Effect.promise(() => followUpLaunch);
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(run.value.waitArrivals).toStrictEqual([
        {
          ...waiting.arrival,
          state: "forwarded",
          forwardedBy: "timer",
          settledAt: waiting.arrival.deadlineAt,
        },
      ]);
      expect(waiting.arrival).toMatchObject({
        message: "Ready for the follow-up.",
        origin: { runId: worker.runId, threadId: worker.threadId },
      });
      expect(Date.parse(waiting.arrival.deadlineAt) - Date.parse(waiting.arrival.startedAt)).toBe(
        WAIT_MINUTES * MINUTE,
      );
      expect(f.t3.launches.size).toBe(2);
      const followUp = yield* f.factory.runtime.block({
        arguments: { blockId: launchBlockId(launched.message) },
      });
      expect(followUp).toMatchObject({ code: "BLOCK", inputs: { feedback: "Ready for the follow-up." } });
      expect(run.value.blocks.find((block) => block.blockId === "cool-down")).toMatchObject({
        state: "finished",
        threadId: null,
      });
    }),
);

it.effect(
  "counting starts when the result is released after the worker finishes, not when it is reported",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultHeld(f.world, worker));
      yield* TestClock.adjust(5 * MINUTE);
      allTurnsEnd(f.world, worker);

      // Act
      const run = yield* Effect.promise(() =>
        observeFor("observe the release", f.world, worker.runId, (detail) =>
          detail.waitArrivals.some((arrival) => arrival.state === "pending"),
        ),
      );

      // Assert
      const [result] = run.reports;
      const [arrival] = run.waitArrivals;
      expect(arrival!.startedAt).toBe(result!.completionEligibleAt);
      expect(Date.parse(arrival!.startedAt) - Date.parse(result!.acceptedAt)).toBe(5 * MINUTE);
      expect(Date.parse(arrival!.deadlineAt) - Date.parse(arrival!.startedAt)).toBe(
        WAIT_MINUTES * MINUTE,
      );
    }),
);

it.effect(
  "parallel arrivals keep their own messages and deadlines, and a terminal Wait forwards one without waiting for the other",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, parallelWaitFlow, scheduledOnly);
      const [first, second] = yield* Effect.promise(() => twoWorkersStarted(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, first, { message: "First branch." }));
      yield* Effect.promise(() => resultReleasedToWait(f.world, first));
      yield* TestClock.adjust(3 * MINUTE);
      yield* Effect.promise(() => resultReported(f.world, second, { message: "Second branch." }));
      yield* Effect.promise(() =>
        observeFor("observe both arrivals", f.world, first.runId, (run) =>
          run.waitArrivals.length === 2,
        ),
      );

      // Act
      yield* TestClock.adjust((WAIT_MINUTES - 3) * MINUTE);

      // Assert
      const run = yield* f.factory.getRun(first.runId);
      assert(run.ok);
      const [early, late] = run.value.waitArrivals;
      expect([early!.message, early!.state]).toStrictEqual(["First branch.", "forwarded"]);
      expect([late!.message, late!.state]).toStrictEqual(["Second branch.", "pending"]);
      expect(Date.parse(late!.deadlineAt) - Date.parse(early!.deadlineAt)).toBe(3 * MINUTE);
      expect(run.value.blocks.find((block) => block.blockId === "cool-down")?.state).toBe(
        "waiting",
      );
      expect(run.value.intents.filter((intent) => intent.waitArrivalId !== null)).toStrictEqual(
        [],
      );
    }),
);

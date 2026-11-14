import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { preparedService } from "./support/prepared-runner.ts";
import {
  enableRunTitles,
  titleThreadLaunched,
  titleThreadReference,
  titleThreadStopRequested,
  titleThreadStops,
} from "./support/scenarios.ts";

const SECOND = 1000;
const DEADLINE = 30 * SECOND;
/** Leaves the periodic reconcile out of the clock, so only the deadline wake-up advances work. */
const scheduledOnly = { connectionRetryMs: 24 * 60 * 60 * SECOND };

/** A Run whose title thread is launched and holds its capability, on the test clock. */
const titleThreadAtWork = (c: Parameters<typeof preparedService>[0]) =>
  Effect.gen(function* () {
    const f = yield* preparedService(c, undefined, scheduledOnly);
    yield* Effect.promise(() => enableRunTitles(f.world.factory));
    const thread = yield* Effect.promise(() => titleThreadLaunched(f.world, f.input));
    return { ...f, ...thread };
  });

it.effect(
  "at its 30-second deadline a pending generation times out quietly, keeps the automatic title and stops the title thread",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* titleThreadAtWork(c);
      const stopped = titleThreadStopRequested(f.t3);

      // Act
      yield* TestClock.adjust(DEADLINE);

      // Assert
      expect(yield* Effect.promise(() => stopped)).toStrictEqual({
        threadId: titleThreadReference(f.t3).threadId,
        clientRequestId: expect.any(String),
      });
      const run = yield* f.factory.getRun(f.runId);
      assert(run.ok);
      expect(run.value.titleGeneration).toMatchObject({
        state: "timed-out",
        reason: "No valid title arrived within 30 seconds of Start.",
      });
      expect(run.value.title).toBe("Improve search");
      expect(run.value.titleProvenance).toBe("automatic");
      expect(run.value.attention).toStrictEqual([]);
    }),
);

it.effect("a title submitted after the deadline is refused and the timeout stays final", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* titleThreadAtWork(c);
    const stopped = titleThreadStopRequested(f.t3);
    yield* TestClock.adjust(DEADLINE);
    yield* Effect.promise(() => stopped);

    // Act
    const reply = yield* f.factory.runtime.title({
      arguments: { titleGenerationId: f.titleGenerationId, title: "Search ranking" },
    });

    // Assert
    expect(reply.code).toBe("TITLE_GENERATION_CLOSED");
    const run = yield* f.factory.getRun(f.runId);
    assert(run.ok);
    expect(run.value.title).toBe("Improve search");
    expect(run.value.titleGeneration).toMatchObject({ state: "timed-out", generatedTitle: null });
  }),
);

it.effect(
  "a restart before the deadline keeps the original deadline and never launches the title thread again",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* titleThreadAtWork(c);
      const before = yield* f.factory.getRun(f.runId);
      assert(before.ok);
      yield* TestClock.adjust(10 * SECOND);
      yield* f.close;
      const recovered = yield* f.reopen;
      const stopped = titleThreadStopRequested(f.t3);

      // Act
      yield* TestClock.adjust(DEADLINE - 10 * SECOND);

      // Assert
      yield* Effect.promise(() => stopped);
      const run = yield* recovered.getRun(f.runId);
      assert(run.ok);
      expect(run.value.titleGeneration).toMatchObject({
        state: "timed-out",
        deadlineAt: before.value.titleGeneration?.deadlineAt,
        threadLink: before.value.titleGeneration?.threadLink,
      });
      expect(f.t3.launchCalls).toBe(2);
    }),
);

it.effect(
  "Archive racing the deadline ends the generation once with one Stop of the title thread",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* titleThreadAtWork(c);
      const stopped = titleThreadStopRequested(f.t3);

      // Act
      const [archived] = yield* Effect.all(
        [f.factory.archiveRun(f.runId), TestClock.adjust(DEADLINE)],
        { concurrency: "unbounded" },
      );

      // Assert
      assert(archived.ok);
      yield* Effect.promise(() => stopped);
      const reconciled = yield* f.factory.reconcileRuns();
      assert(reconciled.ok);
      const run = yield* f.factory.getRun(f.runId);
      assert(run.ok);
      expect(["cancelled", "timed-out"]).toContain(run.value.titleGeneration?.state);
      expect(run.value.title).toBe("Improve search");
      expect(titleThreadStops(f.t3)).toHaveLength(1);
    }),
);

import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { preparedService } from "./support/prepared-runner.ts";
import {
  launchBlockId,
  nextLaunch,
  observeFor,
  parallelWaitFlow,
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
  "Continue now forwards the pending arrival at once, unchanged with its origin, as early by the user",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() =>
        resultReported(f.world, worker, { message: "Ready for the follow-up." }),
      );
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const followUpLaunch = nextLaunch(f.world);

      // Act
      const continued = yield* f.factory.continueWaitArrival(waiting.arrival.id);

      // Assert
      assert(continued.ok);
      expect(continued.value.waitArrivals).toStrictEqual([
        {
          ...waiting.arrival,
          state: "forwarded",
          forwardedBy: "user",
          settledAt: continued.value.waitArrivals[0]!.settledAt,
        },
      ]);
      expect(
        continued.value.events.filter((event) => event.kind.startsWith("wait-")).map((e) => e.kind),
      ).toStrictEqual(["wait-started", "wait-continued"]);
      const launched = yield* Effect.promise(() => followUpLaunch);
      const followUp = yield* f.factory.runtime.block({
        arguments: { blockId: launchBlockId(launched.message) },
      });
      expect(followUp).toMatchObject({ inputs: { feedback: "Ready for the follow-up." } });
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(
        run.value.intents.find((intent) => intent.blockId === "follow-up")?.origin,
      ).toStrictEqual(waiting.arrival.origin);
    }),
);

it.effect(
  "Continue now forwards only the selected arrival; the other keeps waiting with its message and deadline",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, parallelWaitFlow, scheduledOnly);
      const [first, second] = yield* Effect.promise(() => twoWorkersStarted(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, first, { message: "First branch." }));
      const selected = yield* Effect.promise(() => resultReleasedToWait(f.world, first));
      yield* Effect.promise(() => resultReported(f.world, second, { message: "Second branch." }));
      const both = yield* Effect.promise(() =>
        observeFor(
          "observe both arrivals",
          f.world,
          first.runId,
          (run) => run.waitArrivals.length === 2,
        ),
      );
      const other = both.waitArrivals.find((arrival) => arrival.id !== selected.arrival.id)!;

      // Act
      const continued = yield* f.factory.continueWaitArrival(selected.arrival.id);

      // Assert
      assert(continued.ok);
      expect(
        continued.value.waitArrivals.map((arrival) => [arrival.message, arrival.state]),
      ).toStrictEqual([
        ["First branch.", "forwarded"],
        ["Second branch.", "pending"],
      ]);
      expect(continued.value.waitArrivals[1]).toStrictEqual(other);
      expect(continued.value.blocks.find((block) => block.blockId === "cool-down")?.state).toBe(
        "waiting",
      );
    }),
);

it.effect("a repeated Continue now reports already forwarded and delivers nothing more", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    const followUpLaunch = nextLaunch(f.world);
    assert((yield* f.factory.continueWaitArrival(waiting.arrival.id)).ok);
    yield* Effect.promise(() => followUpLaunch);
    const before = yield* f.factory.getRun(worker.runId);
    assert(before.ok);

    // Act
    const repeated = yield* f.factory.continueWaitArrival(waiting.arrival.id);

    // Assert
    assert(!repeated.ok);
    expect(repeated.error).toMatchObject({
      code: "conflict",
      message: "This Wait arrival was already forwarded.",
    });
    const after = yield* f.factory.getRun(worker.runId);
    assert(after.ok);
    expect(after.value.generation).toBe(before.value.generation);
    expect(f.t3.launches.size).toBe(2);
  }),
);

it.effect("Continue now competing with the deadline forwards the arrival once", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    const followUpLaunch = nextLaunch(f.world);

    // Act
    yield* Effect.all(
      [
        TestClock.adjust(WAIT_MINUTES * MINUTE),
        f.factory.continueWaitArrival(waiting.arrival.id),
        f.factory.continueWaitArrival(waiting.arrival.id),
      ],
      { concurrency: "unbounded" },
    );

    // Assert
    yield* Effect.promise(() => followUpLaunch);
    const reconciled = yield* f.factory.reconcileRuns();
    assert(reconciled.ok);
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.waitArrivals[0]?.state).toBe("forwarded");
    expect(
      run.value.events.filter((event) => ["wait-forwarded", "wait-continued"].includes(event.kind)),
    ).toHaveLength(1);
    expect(
      run.value.intents.filter((intent) => intent.waitArrivalId === waiting.arrival.id),
    ).toHaveLength(1);
    expect(f.t3.launches.size).toBe(2);
  }),
);

it.effect("the original deadline after Continue now forwards nothing more", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    const followUpLaunch = nextLaunch(f.world);
    assert((yield* f.factory.continueWaitArrival(waiting.arrival.id)).ok);
    yield* Effect.promise(() => followUpLaunch);

    // Act
    yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

    // Assert
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.waitArrivals[0]).toMatchObject({ state: "forwarded", forwardedBy: "user" });
    expect(
      run.value.events.filter((event) => event.kind.startsWith("wait-")).map((e) => e.kind),
    ).toStrictEqual(["wait-started", "wait-continued"]);
    expect(f.t3.launches.size).toBe(2);
  }),
);

it.effect("a restart after Continue now neither forwards again nor revives the timer", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    const followUpLaunch = nextLaunch(f.world);
    assert((yield* f.factory.continueWaitArrival(waiting.arrival.id)).ok);
    yield* Effect.promise(() => followUpLaunch);
    yield* f.close;
    yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

    // Act
    const recovered = yield* f.reopen;

    // Assert
    const run = yield* recovered.getRun(worker.runId);
    assert(run.ok);
    expect(
      run.value.events.filter((event) => event.kind.startsWith("wait-")).map((e) => e.kind),
    ).toStrictEqual(["wait-started", "wait-continued"]);
    expect(
      run.value.intents.filter((intent) => intent.waitArrivalId === waiting.arrival.id),
    ).toHaveLength(1);
    expect(f.t3.launches.size).toBe(2);
  }),
);

it.effect("Continue now on an archived Run's arrival is refused and forwards nothing", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    assert((yield* f.factory.archiveRun(worker.runId)).ok);

    // Act
    const continued = yield* f.factory.continueWaitArrival(waiting.arrival.id);

    // Assert
    assert(!continued.ok);
    expect(continued.error.code).toBe("conflict");
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.waitArrivals[0]?.state).toBe("cancelled");
    expect(run.value.intents.filter((intent) => intent.blockId === "follow-up")).toStrictEqual([]);
    expect(f.t3.launches.size).toBe(1);
  }),
);

it.effect("Archive racing Continue now leaves no forwarded work to deliver", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

    // Act
    const [archived] = yield* Effect.all(
      [f.factory.archiveRun(worker.runId), f.factory.continueWaitArrival(waiting.arrival.id)],
      { concurrency: "unbounded" },
    );

    // Assert
    assert(archived.ok);
    const reconciled = yield* f.factory.reconcileRuns();
    assert(reconciled.ok);
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.lifecycle).toBe("archived");
    expect(
      run.value.intents.filter(
        (intent) => intent.blockId === "follow-up" && intent.state !== "cancelled",
      ),
    ).toStrictEqual([]);
    expect(f.t3.launches.size).toBe(1);
  }),
);

it.effect("Continue now on a manually Settled Run forwards without reactivating it", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    assert((yield* f.factory.settleRun(worker.runId)).ok);
    const followUpLaunch = nextLaunch(f.world);

    // Act
    const continued = yield* f.factory.continueWaitArrival(waiting.arrival.id);

    // Assert
    assert(continued.ok);
    expect(continued.value.lifecycle).toBe("settled");
    yield* Effect.promise(() => followUpLaunch);
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.activations.map((activation) => activation.blockId)).toStrictEqual([
      "worker",
      "follow-up",
    ]);
  }),
);

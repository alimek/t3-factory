import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { preparedService } from "./support/prepared-runner.ts";
import {
  allTurnsEnd,
  consecutiveWaitFlow,
  launchBlockId,
  loopWaitFlow,
  observeFor,
  parallelWaitFlow,
  resultHeld,
  resultReleasedToWait,
  resultReported,
  sentTurnBegins,
  snoozed,
  terminalWaitFlow,
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
      expect(followUp).toMatchObject({
        code: "BLOCK",
        inputs: { feedback: "Ready for the follow-up." },
      });
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
        observeFor(
          "observe both arrivals",
          f.world,
          first.runId,
          (run) => run.waitArrivals.length === 2,
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
      expect(run.value.intents.filter((intent) => intent.waitArrivalId !== null)).toStrictEqual([]);
    }),
);

it.effect(
  "a restart before the deadline keeps the original deadline and message and forwards at it",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "Kept." }));
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      yield* TestClock.adjust(4 * MINUTE);
      yield* f.close;
      const recovered = yield* f.reopen;
      const followUpLaunch = f.t3.nextLaunch();

      // Act
      yield* TestClock.adjust((WAIT_MINUTES - 4) * MINUTE);

      // Assert
      yield* Effect.promise(() => followUpLaunch);
      const run = yield* recovered.getRun(worker.runId);
      assert(run.ok);
      expect(run.value.waitArrivals).toStrictEqual([
        {
          ...waiting.arrival,
          state: "forwarded",
          forwardedBy: "timer",
          settledAt: waiting.arrival.deadlineAt,
        },
      ]);
    }),
);

it.effect(
  "a restart after the deadline forwards the overdue arrival once without moving its deadline",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker));
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      yield* f.close;
      yield* TestClock.adjust(6 * WAIT_MINUTES * MINUTE);
      const followUpLaunch = f.t3.nextLaunch();

      // Act
      const recovered = yield* f.reopen;

      // Assert
      yield* Effect.promise(() => followUpLaunch);
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);
      const run = yield* recovered.getRun(worker.runId);
      assert(run.ok);
      const [arrival] = run.value.waitArrivals;
      expect(arrival).toMatchObject({
        state: "forwarded",
        startedAt: waiting.arrival.startedAt,
        deadlineAt: waiting.arrival.deadlineAt,
      });
      expect(Date.parse(arrival!.settledAt!) - Date.parse(arrival!.startedAt)).toBe(
        6 * WAIT_MINUTES * MINUTE,
      );
      expect(run.value.events.filter((event) => event.kind === "wait-forwarded")).toHaveLength(1);
      expect(
        run.value.intents.filter((intent) => intent.waitArrivalId === arrival!.id),
      ).toHaveLength(1);
      expect(f.t3.launches.size).toBe(2);
    }),
);

it.effect(
  "a restart after a committed forwarding delivers its handoff without forwarding again",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker));
      yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      f.t3.available = false;
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);
      const forwarded = yield* f.factory.getRun(worker.runId);
      assert(forwarded.ok);
      expect(forwarded.value.waitArrivals[0]?.state).toBe("forwarded");
      yield* f.close;
      f.t3.available = true;
      const followUpLaunch = f.t3.nextLaunch();

      // Act
      const recovered = yield* f.reopen;

      // Assert
      yield* Effect.promise(() => followUpLaunch);
      const run = yield* recovered.getRun(worker.runId);
      assert(run.ok);
      expect(run.value.events.filter((event) => event.kind === "wait-forwarded")).toHaveLength(1);
      expect(
        run.value.intents.filter((intent) => intent.blockId === "follow-up").map((i) => i.kind),
      ).toStrictEqual(["launch"]);
      expect(f.t3.launches.size).toBe(2);
    }),
);

it.effect("a pending Wait keeps the Run from settling automatically", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, terminalWaitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

    // Act
    const reconciled = yield* f.factory.reconcileRuns();

    // Assert
    assert(reconciled.ok);
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.lifecycle).toBe("active");
    expect(run.value.blocks.find((block) => block.blockId === "cool-down")?.state).toBe("waiting");
  }),
);

it.effect("a manually Settled Run keeps its Wait, which still forwards to the next Agent", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    assert((yield* f.factory.settleRun(worker.runId)).ok);
    const followUpLaunch = f.t3.nextLaunch();

    // Act
    yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

    // Assert
    yield* Effect.promise(() => followUpLaunch);
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.lifecycle).toBe("settled");
    expect(run.value.waitArrivals[0]?.state).toBe("forwarded");
    expect(run.value.activations.map((activation) => activation.blockId)).toStrictEqual([
      "worker",
      "follow-up",
    ]);
  }),
);

it.effect(
  "Archive cancels a pending arrival, clears its message and stops the Wait; its deadline forwards nothing",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "Do not keep." }));
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const archived = yield* f.factory.archiveRun(worker.runId);
      assert(archived.ok);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(run.value.waitArrivals).toStrictEqual([
        {
          ...waiting.arrival,
          state: "cancelled",
          message: null,
          settledAt: archived.value.waitArrivals[0]!.settledAt,
        },
      ]);
      expect(run.value.blocks.find((block) => block.blockId === "cool-down")?.state).toBe(
        "stopped",
      );
      expect(
        run.value.events.filter((event) => event.kind.startsWith("wait-")).map((e) => e.kind),
      ).toStrictEqual(["wait-started", "wait-cancelled"]);
      expect(run.value.intents.filter((intent) => intent.blockId === "follow-up")).toStrictEqual(
        [],
      );
      expect(f.t3.launches.size).toBe(1);
    }),
);

it.effect("Archive racing the deadline leaves no forwarded work to deliver", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker));
    yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

    // Act
    const [archived] = yield* Effect.all(
      [f.factory.archiveRun(worker.runId), TestClock.adjust(WAIT_MINUTES * MINUTE)],
      { concurrency: "unbounded" },
    );

    // Assert
    assert(archived.ok);
    const reconciled = yield* f.factory.reconcileRuns();
    assert(reconciled.ok);
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.lifecycle).toBe("archived");
    expect(run.value.waitArrivals[0]?.message).toBeNull();
    expect(
      run.value.intents.filter(
        (intent) => intent.blockId === "follow-up" && intent.state !== "cancelled",
      ),
    ).toStrictEqual([]);
    expect(f.t3.launches.size).toBe(1);
  }),
);

it.effect("a Wait raises no attention and leaves a Snoozed Run snoozed", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => snoozed(f.world, worker));
    yield* Effect.promise(() => resultReported(f.world, worker));

    // Act
    yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

    // Assert
    const navigation = yield* f.factory.listRunNavigation();
    assert(navigation.ok);
    expect(navigation.value[0]).toMatchObject({
      presentation: { snoozed: true, woke: false },
      attention: { needsInput: false, problem: false, matters: [] },
    });
  }),
);

it.effect(
  "consecutive Waits forward the original worker's message and origin to the next Agent",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, consecutiveWaitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "Twice delayed." }));
      const first = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);
      yield* Effect.promise(() =>
        observeFor("observe the second Wait", f.world, worker.runId, (run) =>
          run.waitArrivals.some((arrival) => arrival.blockId === "settle-in"),
        ),
      );
      const followUpLaunch = f.t3.nextLaunch();

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const launched = yield* Effect.promise(() => followUpLaunch);
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(
        run.value.waitArrivals.map((arrival) => [arrival.blockId, arrival.message]),
      ).toStrictEqual([
        ["cool-down", "Twice delayed."],
        ["settle-in", "Twice delayed."],
      ]);
      expect(run.value.waitArrivals[1]?.origin).toStrictEqual(first.arrival.origin);
      expect(
        run.value.intents.find((intent) => intent.blockId === "follow-up")?.origin,
      ).toStrictEqual(first.arrival.origin);
      const followUp = yield* f.factory.runtime.block({
        arguments: { blockId: launchBlockId(launched.message) },
      });
      expect(followUp).toMatchObject({ inputs: { feedback: "Twice delayed." } });
    }),
);

it.effect("a loop back through a Wait records each revisit as its own arrival", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, loopWaitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker, { message: "First pass." }));
    const first = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    const revisitSent = f.t3.nextSend();
    yield* TestClock.adjust(WAIT_MINUTES * MINUTE);
    const revisit = yield* Effect.promise(() => revisitSent);
    const again = sentTurnBegins(f.world, worker);
    yield* Effect.promise(() => resultReported(f.world, again, { message: "Second pass." }));

    // Act
    const run = yield* Effect.promise(() =>
      observeFor("observe the revisit's arrival", f.world, worker.runId, (detail) =>
        detail.waitArrivals.some((arrival) => arrival.state === "pending"),
      ),
    );

    // Assert
    expect(revisit.message).toContain("First pass.");
    expect(run.waitArrivals.map((arrival) => [arrival.message, arrival.state])).toStrictEqual([
      ["First pass.", "forwarded"],
      ["Second pass.", "pending"],
    ]);
    expect(run.waitArrivals[0]?.deadlineAt).toBe(first.arrival.deadlineAt);
    expect(run.waitArrivals[1]?.origin?.activationId).not.toBe(first.arrival.origin?.activationId);
  }),
);

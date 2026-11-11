import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { preparedService } from "./support/prepared-runner.ts";
import {
  allTurnsEnd,
  consecutiveWaitFlow,
  fanOutWaitFlow,
  finishedReport,
  humanThenWaitFlow,
  launchBlockId,
  loopWaitFlow,
  nextLaunch,
  nextSend,
  observeFor,
  type ReadyFlowShape,
  report,
  parallelHumanWaitFlow,
  parallelWaitFlow,
  resultHeld,
  resultReleasedToHumanReview,
  resultReleasedToWait,
  resultReported,
  reviewWaitContinuationFlow,
  reviewedLoopWaitFlow,
  sentTurnBegins,
  snoozed,
  terminalWaitFlow,
  turnBegins,
  twoWorkersStarted,
  WAIT_MINUTES,
  waitContinuationFlow,
  waitFlow,
  waitHumanWaitFlow,
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
      const followUpLaunch = nextLaunch(f.world);

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

it.effect("a Wait's output reaches each of its two recipients once", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, fanOutWaitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker, { message: "For both." }));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

    // Act
    yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

    // Assert
    const run = yield* Effect.promise(() =>
      observeFor("observe both launches", f.world, worker.runId, (detail) =>
        detail.intents
          .filter((intent) => intent.waitArrivalId === waiting.arrival.id)
          .every((intent) => intent.state === "acknowledged"),
      ),
    );
    expect(
      run.intents
        .filter((intent) => intent.waitArrivalId === waiting.arrival.id)
        .map((intent) => [intent.blockId, intent.kind]),
    ).toStrictEqual([
      ["follow-up", "launch"],
      ["notify", "launch"],
    ]);
    expect(run.activations.map((activation) => activation.blockId)).toStrictEqual([
      "worker",
      "follow-up",
      "notify",
    ]);
    expect(f.t3.launches.size).toBe(3);
  }),
);

it.effect("a repeated delivery of the same result to a Wait keeps its one arrival", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, waitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker, { message: "Once." }));
    const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

    // Act
    const repeated = yield* Effect.promise(() => report(f.world, worker, finishedReport("Once.")));

    // Assert
    expect(repeated).toBe("ACCEPTED");
    const run = yield* f.factory.getRun(worker.runId);
    assert(run.ok);
    expect(run.value.waitArrivals).toStrictEqual([waiting.arrival]);
    expect(run.value.intents.filter((intent) => intent.blockId === "cool-down")).toHaveLength(1);
    expect(run.value.events.filter((event) => event.kind === "wait-started")).toHaveLength(1);
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
      expect([early!.message, early!.state]).toStrictEqual([null, "forwarded"]);
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
      const followUpLaunch = nextLaunch(f.world);

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
      const followUpLaunch = nextLaunch(f.world);

      // Act
      const recovered = yield* f.reopen;

      // Assert
      yield* Effect.promise(() => followUpLaunch);
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
      const followUpLaunch = nextLaunch(f.world);

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

it.effect(
  "a forwarded arrival no recipient reads clears its message and keeps its outcome and deadline",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, terminalWaitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() =>
        resultReported(f.world, worker, { message: "Not needed later." }),
      );
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(run.value.waitArrivals).toStrictEqual([
        {
          ...waiting.arrival,
          state: "forwarded",
          forwardedBy: "timer",
          message: null,
          settledAt: waiting.arrival.deadlineAt,
        },
      ]);
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

it.effect(
  "manual Settle cancels a pending arrival, and its deadline neither forwards it nor revives the Run",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "Do not forward." }));
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const settledRun = yield* f.factory.settleRun(worker.runId, {});
      assert(settledRun.ok);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(run.value.lifecycle).toBe("settled");
      expect(run.value.waitArrivals).toMatchObject([
        { id: waiting.arrival.id, state: "cancelled", forwardedBy: null, message: null },
      ]);
      expect(run.value.blocks.find((block) => block.blockId === "cool-down")?.state).toBe(
        "stopped",
      );
      expect(
        run.value.events.filter((event) => event.kind.startsWith("wait-")).map((e) => e.kind),
      ).toStrictEqual(["wait-started", "wait-cancelled"]);
      expect(run.value.activations.map((activation) => activation.blockId)).toStrictEqual([
        "worker",
      ]);
      expect(f.t3.launches.size).toBe(1);
    }),
);

it.effect(
  "a deadline that passes while a confirmed Settle is stopping workers forwards nothing",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker));
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      turnBegins(f.world, worker, "chat-after-release");
      const stopping = yield* f.factory.settleRun(worker.runId, { stopWorkers: true });
      assert(stopping.ok);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(run.value).toMatchObject({
        lifecycle: "active",
        gateOpen: false,
        settlement: { state: "stopping" },
      });
      expect(run.value.waitArrivals).toMatchObject([{ id: waiting.arrival.id, state: "pending" }]);
      expect(f.t3.launches.size).toBe(1);
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
      const followUpLaunch = nextLaunch(f.world);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const launched = yield* Effect.promise(() => followUpLaunch);
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      expect(
        run.value.waitArrivals.map((arrival) => [arrival.blockId, arrival.message]),
      ).toStrictEqual([
        ["cool-down", null],
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

/** A Run of `shape` whose Entry worker reported "Agreed scope." and finished. */
const scopeReported = (c: Parameters<typeof preparedService>[0], shape: ReadyFlowShape) =>
  Effect.gen(function* () {
    const f = yield* preparedService(c, shape, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker, { message: "Agreed scope." }));
    return { f, worker };
  });

it.effect(
  "a Continuation directly after a Wait queues its prompt on the original worker's thread once the wait elapses",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { f, worker } = yield* scopeReported(c, waitContinuationFlow);
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const promptSend = nextSend(f.world);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const sent = yield* Effect.promise(() => promptSend);
      expect(sent.threadId).toBe(worker.threadId);
      expect(sent.message).toContain("Write the spec from what we agreed.");
      expect(sent.message).not.toContain("Reply from");
      expect(f.t3.launches.size).toBe(1);
      expect(waiting.arrival.origin).toMatchObject({
        runId: worker.runId,
        threadId: worker.threadId,
      });
    }),
);

it.effect(
  "a Continuation after a Human step and a Wait queues its prompt with the reply on the original worker's thread once the wait elapses",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { f, worker } = yield* scopeReported(c, reviewWaitContinuationFlow);
      const review = yield* Effect.promise(() => resultReleasedToHumanReview(f.world, worker));
      const answered = yield* f.factory.answerHumanOccurrence(review.occurrence.id, {
        exitId: "approve",
        message: "Spec it without SMS login.",
      });
      assert(answered.ok);
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const promptSend = nextSend(f.world);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const sent = yield* Effect.promise(() => promptSend);
      expect(sent.threadId).toBe(worker.threadId);
      expect(sent.message).toContain(
        'Write the spec from what we agreed.\n\nReply from the Human step "Review" (Approve):\nSpec it without SMS login.',
      );
      expect(launchBlockId(sent.message)).not.toBe(worker.blockId);
      expect(f.t3.launches.size).toBe(1);
      expect(waiting.arrival.origin).toMatchObject({
        runId: worker.runId,
        threadId: worker.threadId,
        activationId: expect.any(String),
      });
      const run = yield* Effect.promise(() =>
        observeFor("observe the prompt", f.world, worker.runId, (detail) =>
          detail.blocks.some((block) => block.blockId === "spec" && block.state === "sent"),
        ),
      );
      expect(run.continuationVisits).toMatchObject([
        { blockId: "spec", kind: "prompt", sourceBlockId: "cool-down", state: "sent" },
      ]);
    }),
);

it.effect("a loop back through a Wait records each revisit as its own arrival", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c, loopWaitFlow, scheduledOnly);
    const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
    yield* Effect.promise(() => resultReported(f.world, worker, { message: "First pass." }));
    const first = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
    const revisitSent = nextSend(f.world);
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

it.effect(
  "an approved Human answer waits with the reviewed worker's origin and reaches the next Agent",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, humanThenWaitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "Ready to review." }));
      const review = yield* Effect.promise(() => resultReleasedToHumanReview(f.world, worker));
      const answered = yield* f.factory.answerHumanOccurrence(review.occurrence.id, {
        exitId: "approve",
        message: "Ship it after the cool-down.",
      });
      assert(answered.ok);
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const followUpLaunch = nextLaunch(f.world);

      // Act
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);

      // Assert
      const launched = yield* Effect.promise(() => followUpLaunch);
      const run = yield* f.factory.getRun(worker.runId);
      assert(run.ok);
      const reviewed = run.value.intents.find(
        (intent) => intent.id === review.occurrence.incomingIntentId,
      )!.origin;
      expect(reviewed).toMatchObject({ runId: worker.runId, threadId: worker.threadId });
      expect(waiting.arrival).toMatchObject({
        message: "Ship it after the cool-down.",
        origin: reviewed,
      });
      expect(
        run.value.intents.find((intent) => intent.blockId === "follow-up")?.origin,
      ).toStrictEqual(reviewed);
      const followUp = yield* f.factory.runtime.block({
        arguments: { blockId: launchBlockId(launched.message) },
      });
      expect(followUp).toMatchObject({ inputs: { feedback: "Ship it after the cool-down." } });
      expect(run.value.blocks.find((block) => block.blockId === "review")).toMatchObject({
        state: "finished",
        threadId: null,
      });
    }),
);

it.effect(
  "a Human review pending across a restart forwards the delayed worker's origin with its answer",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, waitHumanWaitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "Delayed review." }));
      const waiting = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);
      const review = yield* Effect.promise(() => resultReleasedToHumanReview(f.world, worker));
      yield* f.close;
      const recovered = yield* f.reopen;

      // Act
      const answered = yield* recovered.answerHumanOccurrence(review.occurrence.id, {
        exitId: "approve",
      });

      // Assert
      assert(answered.ok);
      expect(review.occurrence.context).toBe("Delayed review.");
      expect(
        answered.value.intents.find((intent) => intent.occurrenceId === review.occurrence.id),
      ).toMatchObject({ blockId: "settle-in", origin: waiting.arrival.origin });
      expect(waiting.arrival.origin).toMatchObject({ threadId: worker.threadId });
    }),
);

it.effect(
  "answering one of two parallel reviews forwards its own worker's origin, not the other's",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, parallelHumanWaitFlow, scheduledOnly);
      const [first, second] = yield* Effect.promise(() => twoWorkersStarted(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, first, { message: "First branch." }));
      yield* Effect.promise(() => resultReported(f.world, second, { message: "Second branch." }));
      const reviews = yield* Effect.promise(() =>
        observeFor(
          "observe both reviews",
          f.world,
          first.runId,
          (run) =>
            run.humanOccurrences.filter((occurrence) => occurrence.state === "pending").length ===
            2,
        ),
      );
      const secondReview = reviews.humanOccurrences.find(
        (occurrence) => occurrence.context === "Second branch.",
      )!;

      // Act
      const answered = yield* f.factory.answerHumanOccurrence(secondReview.id, {
        exitId: "approve",
      });

      // Assert
      assert(answered.ok);
      expect(
        answered.value.intents.find((intent) => intent.occurrenceId === secondReview.id)?.origin,
      ).toMatchObject({ runId: second.runId, threadId: second.threadId });
      expect(second.threadId).not.toBe(first.threadId);
      expect(answered.value.humanOccurrences).toMatchObject([
        { context: "First branch.", state: "pending" },
        { id: secondReview.id, state: "answered" },
      ]);
    }),
);

it.effect(
  "a review answered after its worker's later visit forwards the reviewed visit's activation",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* preparedService(c, reviewedLoopWaitFlow, scheduledOnly);
      const worker = yield* Effect.promise(() => workerAtWork(f.world, f.input));
      yield* Effect.promise(() => resultReported(f.world, worker, { message: "First pass." }));
      const first = yield* Effect.promise(() => resultReleasedToWait(f.world, worker));
      const revisitSent = nextSend(f.world);
      yield* TestClock.adjust(WAIT_MINUTES * MINUTE);
      yield* Effect.promise(() => revisitSent);
      const again = sentTurnBegins(f.world, worker);
      yield* Effect.promise(() => resultReported(f.world, again, { message: "Second pass." }));
      const reviews = yield* Effect.promise(() =>
        observeFor(
          "observe the second review",
          f.world,
          worker.runId,
          (run) =>
            run.humanOccurrences.filter((occurrence) => occurrence.state === "pending").length ===
            2,
        ),
      );
      const firstReview = reviews.humanOccurrences.find(
        (occurrence) => occurrence.context === "First pass.",
      )!;

      // Act
      const answered = yield* f.factory.answerHumanOccurrence(firstReview.id, {
        exitId: "approve",
      });

      // Assert
      assert(answered.ok);
      const visits = answered.value.activations.filter((visit) => visit.blockId === "worker");
      expect(visits).toHaveLength(2);
      expect(first.arrival.origin?.activationId).toBe(visits[0]!.id);
      expect(
        answered.value.intents.find((intent) => intent.occurrenceId === firstReview.id)?.origin,
      ).toStrictEqual(first.arrival.origin);
    }),
);

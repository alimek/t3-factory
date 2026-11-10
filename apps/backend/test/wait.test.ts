import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { promptOn } from "./support/continuation.ts";
import {
  allTurnsEnd,
  humanWaitFlow,
  launchBlockId,
  parallelWaitFlow,
  sentTurnBegins,
  terminalWaitFlow,
  waitContinuationFlow,
  waitFlow,
  waitLoopFlow,
} from "./support/scenarios.ts";
import {
  arrivalStates,
  at,
  blockState,
  launchedBlock,
  launchedWorker,
  minutes,
  openOnTestClock,
  reportOn,
  resultWaiting,
  reviewPendingOnTestClock,
  runAfterWake,
  runOn,
  workerAtWorkOnTestClock,
} from "./support/wait.ts";

const RESULT = "Implemented the requested result.";

it.effect("a released result waits at a Wait without a worker until its deadline", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, waitFlow);

    // Act
    yield* TestClock.adjust(minutes(30) - 1000);

    // Assert
    const run = yield* runOn(f.factory, f.worker.runId);
    expect(run.waitArrivals).toMatchObject([
      {
        blockId: "cool-down",
        sourceBlockId: "worker",
        state: "pending",
        message: RESULT,
        startedAt: at("09:00"),
        deadlineAt: at("09:30"),
        settledAt: null,
      },
    ]);
    expect(run.blocks.find((block) => block.blockId === "cool-down")).toMatchObject({
      state: "waiting",
      threadId: null,
    });
    expect(run.activations.map((activation) => activation.blockId)).toStrictEqual(["worker"]);
    expect(f.t3.launches.size).toBe(1);
  }),
);

it.effect(
  "at its deadline a Wait forwards the message unchanged, with its origin, to every recipient",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* resultWaiting(c, waitFlow);

      // Act
      yield* TestClock.adjust(minutes(30));

      // Assert
      const run = yield* runAfterWake(
        f.factory,
        f.worker.runId,
        (detail) => launchedBlock("follow-up")(detail) && launchedBlock("parallel-block")(detail),
      );
      const [arrival] = run.waitArrivals;
      expect(arrival).toMatchObject({
        state: "forwarded",
        forwardReason: "elapsed",
        message: null,
        deadlineAt: at("09:30"),
        settledAt: at("09:30"),
        reportId: run.reports[0]!.id,
        origin: { threadId: f.worker.threadId, activationId: run.activations[0]!.id },
      });
      expect(blockState(run, "cool-down")).toBe("finished");
      expect(run.activations.map((activation) => activation.blockId)).toStrictEqual([
        "worker",
        "follow-up",
        "parallel-block",
      ]);
      const followUp = run.blocks.find((block) => block.blockId === "follow-up")!;
      const launch = [...f.t3.launches.values()].find(
        (entry) => entry.reference.threadId === followUp.threadId,
      )!;
      const block = yield* f.factory.runtime.block({
        arguments: { blockId: launchBlockId(launch.payload.message) },
      });
      expect(block.inputs?.results).toMatchObject([{ blockId: "worker", message: RESULT }]);
      expect(
        run.events.map((event) => event.kind).filter((kind) => kind.startsWith("wait-")),
      ).toStrictEqual(["wait-started", "wait-elapsed"]);
    }),
);

it.effect("counting starts when the result is released, not when its report is accepted", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* workerAtWorkOnTestClock(c, waitFlow);
    assert(
      (yield* reportOn(f.factory, f.worker, { to: "finished", exit: "done", message: RESULT })) ===
        "ACCEPTED",
    );
    yield* TestClock.adjust(minutes(10));
    allTurnsEnd(f.world, f.worker);

    // Act
    assert((yield* f.factory.reconcileRuns()).ok);

    // Assert
    const run = yield* runOn(f.factory, f.worker.runId);
    expect(run.reports[0]?.acceptedAt).toBe(at("09:00"));
    expect(run.waitArrivals).toMatchObject([
      { state: "pending", startedAt: at("09:10"), deadlineAt: at("09:40") },
    ]);
  }),
);

it.effect("parallel arrivals at one Wait keep their own messages and deadlines", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, parallelWaitFlow);
    const parallel = yield* launchedWorker(
      f,
      yield* runAfterWake(f.factory, f.worker.runId, launchedBlock("parallel-block")),
      "parallel-block",
    );
    yield* TestClock.adjust(minutes(10));
    assert(
      (yield* reportOn(f.factory, parallel, {
        to: "finished",
        exit: "done",
        message: "Security notes ready.",
      })) === "ACCEPTED",
    );
    allTurnsEnd(f.world, parallel);
    assert((yield* f.factory.reconcileRuns()).ok);

    // Act
    yield* TestClock.adjust(minutes(20));

    // Assert
    const run = yield* runAfterWake(f.factory, f.worker.runId, launchedBlock("follow-up"));
    expect(run.waitArrivals).toMatchObject([
      { sourceBlockId: "worker", state: "forwarded", settledAt: at("09:30"), message: null },
      {
        sourceBlockId: "parallel-block",
        state: "pending",
        message: "Security notes ready.",
        startedAt: at("09:10"),
        deadlineAt: at("09:40"),
      },
    ]);
    expect(blockState(run, "cool-down")).toBe("waiting");
    expect(run.activations.filter((activation) => activation.blockId === "follow-up")).toHaveLength(
      1,
    );
  }),
);

it.effect(
  "a loop revisit that reaches the Wait again is a new arrival with its own message and deadline",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* resultWaiting(c, waitLoopFlow);
      yield* TestClock.adjust(minutes(30));
      yield* runAfterWake(f.factory, f.worker.runId, () => f.t3.sends.size === 1);
      const revisit = sentTurnBegins(f.world, f.worker);
      assert(
        (yield* reportOn(f.factory, revisit, {
          to: "finished",
          exit: "done",
          message: "Second pass done.",
        })) === "ACCEPTED",
      );
      allTurnsEnd(f.world, revisit);

      // Act
      assert((yield* f.factory.reconcileRuns()).ok);

      // Assert
      const run = yield* runOn(f.factory, f.worker.runId);
      expect(run.waitArrivals).toMatchObject([
        { state: "forwarded", settledAt: at("09:30") },
        {
          state: "pending",
          message: "Second pass done.",
          startedAt: at("09:30"),
          deadlineAt: at("10:00"),
        },
      ]);
      expect([...f.t3.sends.values()][0]?.payload.message).toContain(RESULT);
    }),
);

it.effect(
  "a message that waited at consecutive Waits still continues the original worker's thread",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* resultWaiting(c, waitContinuationFlow);
      yield* TestClock.adjust(minutes(10));
      yield* runAfterWake(f.factory, f.worker.runId, (run) => run.waitArrivals.length === 2);

      // Act
      yield* TestClock.adjust(minutes(20));

      // Assert
      const run = yield* runAfterWake(f.factory, f.worker.runId, () => f.t3.sends.size === 1);
      expect(arrivalStates(run)).toStrictEqual(["forwarded", "forwarded"]);
      expect(run.waitArrivals[1]).toMatchObject({
        blockId: "cool-down",
        sourceBlockId: "settle",
        startedAt: at("09:10"),
        reportId: run.reports[0]!.id,
        origin: { threadId: f.worker.threadId, activationId: run.activations[0]!.id },
      });
      expect([...f.t3.sends.values()].map((send) => send.payload.threadId)).toStrictEqual([
        f.worker.threadId,
      ]);
      expect(promptOn(f.world, f.worker).message).toContain("Write the spec from what we agreed.");
    }),
);

it.effect(
  "a Human answer waits at a Wait and then reaches the next Human step with its worker",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* reviewPendingOnTestClock(c, humanWaitFlow);
      assert(
        (yield* f.factory.answerHumanOccurrence(f.review.occurrence.id, {
          exitId: "approve",
          message: "Ship it after the cool-down.",
        })).ok,
      );
      yield* runAfterWake(f.factory, f.worker.runId, (run) => run.waitArrivals.length === 1);

      // Act
      yield* TestClock.adjust(minutes(30));

      // Assert
      const run = yield* runAfterWake(f.factory, f.worker.runId, (detail) =>
        detail.humanOccurrences.some((occurrence) => occurrence.blockId === "sign-off"),
      );
      expect(run.waitArrivals).toMatchObject([
        {
          sourceBlockId: "review",
          state: "forwarded",
          reportId: null,
          origin: { threadId: f.worker.threadId },
        },
      ]);
      expect(
        run.humanOccurrences.find((occurrence) => occurrence.blockId === "sign-off"),
      ).toMatchObject({
        state: "pending",
        context: "Ship it after the cool-down.",
      });
      expect(f.t3.launches.size).toBe(1);
    }),
);

it.effect(
  "after a restart before its deadline an arrival is forwarded at its original deadline",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* resultWaiting(c, waitFlow);
      yield* TestClock.adjust(minutes(10));
      yield* f.close;
      const reopened = yield* openOnTestClock(f);

      // Act
      yield* TestClock.adjust(minutes(20));

      // Assert
      const run = yield* runAfterWake(reopened.factory, f.worker.runId, launchedBlock("follow-up"));
      expect(run.waitArrivals).toMatchObject([
        {
          state: "forwarded",
          startedAt: at("09:00"),
          deadlineAt: at("09:30"),
          settledAt: at("09:30"),
        },
      ]);
    }),
);

it.effect(
  "an arrival whose deadline passed while Factory was closed is forwarded once on reopening",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* resultWaiting(c, waitFlow);
      yield* f.close;
      yield* TestClock.adjust(minutes(120));

      // Act
      const reopened = yield* openOnTestClock(f);

      // Assert
      const run = yield* runAfterWake(reopened.factory, f.worker.runId, launchedBlock("follow-up"));
      expect(run.waitArrivals).toMatchObject([
        { state: "forwarded", deadlineAt: at("09:30"), settledAt: at("11:00") },
      ]);
      expect(run.intents.filter((intent) => intent.sourceBlockId === "cool-down")).toHaveLength(2);
      expect(f.t3.launches.size).toBe(3);
    }),
);

it.effect("a Wait forwards at its deadline while T3 is unavailable", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, waitFlow);
    f.t3.available = false;

    // Act
    yield* TestClock.adjust(minutes(30));

    // Assert
    const run = yield* runAfterWake(
      f.factory,
      f.worker.runId,
      (detail) => arrivalStates(detail)[0] === "forwarded",
    );
    expect(run.waitArrivals).toMatchObject([{ state: "forwarded", settledAt: at("09:30") }]);
    expect(
      run.intents
        .filter((intent) => intent.sourceBlockId === "cool-down")
        .map((intent) => [intent.kind, intent.state]),
    ).toStrictEqual([
      ["handoff", "pending"],
      ["handoff", "pending"],
    ]);
    expect(f.t3.launches.size).toBe(1);
  }),
);

it.effect("reopening after a committed forwarding delivers it once without forwarding again", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, waitFlow);
    f.t3.available = false;
    yield* TestClock.adjust(minutes(30));
    yield* runAfterWake(f.factory, f.worker.runId, (run) => arrivalStates(run)[0] === "forwarded");
    yield* f.close;
    f.t3.available = true;

    // Act
    const reopened = yield* openOnTestClock(f);

    // Assert
    const run = yield* runAfterWake(
      reopened.factory,
      f.worker.runId,
      (detail) => launchedBlock("follow-up")(detail) && launchedBlock("parallel-block")(detail),
    );
    expect(run.waitArrivals).toMatchObject([{ state: "forwarded", settledAt: at("09:30") }]);
    expect(run.intents.filter((intent) => intent.sourceBlockId === "cool-down")).toHaveLength(2);
    expect(f.t3.launches.size).toBe(3);
  }),
);

it.effect("a pending Wait keeps the Run from settling automatically", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, terminalWaitFlow);

    // Act
    assert((yield* f.factory.reconcileRuns()).ok);

    // Assert
    const run = yield* runOn(f.factory, f.worker.runId);
    expect(run.lifecycle).toBe("active");
    expect(arrivalStates(run)).toStrictEqual(["pending"]);
  }),
);

it.effect(
  "a Wait without recipients finishes at its deadline and the Run then settles automatically",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const f = yield* resultWaiting(c, terminalWaitFlow);

      // Act
      yield* TestClock.adjust(minutes(30));

      // Assert
      const run = yield* runAfterWake(
        f.factory,
        f.worker.runId,
        (detail) => detail.lifecycle === "settled",
      );
      expect(run.lifecycle).toBe("settled");
      expect(blockState(run, "cool-down")).toBe("finished");
      expect(run.intents.filter((intent) => intent.sourceBlockId === "cool-down")).toStrictEqual(
        [],
      );
    }),
);

it.effect("a manually Settled Run still forwards its Wait at the deadline", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, waitFlow);
    assert((yield* f.factory.settleRun(f.worker.runId)).ok);

    // Act
    yield* TestClock.adjust(minutes(30));

    // Assert
    const run = yield* runAfterWake(f.factory, f.worker.runId, launchedBlock("follow-up"));
    expect(arrivalStates(run)).toStrictEqual(["forwarded"]);
    expect(run.lifecycle).toBe("settled");
    expect(launchedBlock("follow-up")(run)).toBe(true);
  }),
);

it.effect("Archive cancels a pending arrival, clears its message and stops the Wait", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, waitFlow);

    // Act
    const archived = yield* f.factory.archiveRun(f.worker.runId);

    // Assert
    assert(archived.ok);
    expect(archived.value.waitArrivals).toMatchObject([
      {
        state: "cancelled",
        forwardReason: null,
        message: null,
        deadlineAt: at("09:30"),
        settledAt: at("09:00"),
      },
    ]);
    expect(blockState(archived.value, "cool-down")).toBe("stopped");
    expect(archived.value.events.map((event) => event.kind)).toContain("wait-cancelled");
  }),
);

it.effect("a deadline reached after Archive forwards nothing", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* resultWaiting(c, waitFlow);
    assert((yield* f.factory.archiveRun(f.worker.runId)).ok);

    // Act
    yield* TestClock.adjust(minutes(30));

    // Assert
    const run = yield* runAfterWake(f.factory, f.worker.runId, () => false);
    expect(arrivalStates(run)).toStrictEqual(["cancelled"]);
    expect(run.intents.filter((intent) => intent.sourceBlockId === "cool-down")).toStrictEqual([]);
    expect(f.t3.launches.size).toBe(1);
  }),
);

it.effect("a pending Wait raises no attention and leaves a snoozed Run snoozed", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* workerAtWorkOnTestClock(c, waitFlow);
    assert((yield* f.factory.snoozeRun(f.worker.runId)).ok);
    assert(
      (yield* reportOn(f.factory, f.worker, { to: "finished", exit: "done", message: RESULT })) ===
        "ACCEPTED",
    );
    allTurnsEnd(f.world, f.worker);

    // Act
    assert((yield* f.factory.reconcileRuns()).ok);

    // Assert
    const run = yield* runOn(f.factory, f.worker.runId);
    expect(arrivalStates(run)).toStrictEqual(["pending"]);
    expect(run.attention.filter((matter) => !matter.settledAt)).toStrictEqual([]);
    const navigation = yield* f.factory.listRunNavigation();
    assert(navigation.ok);
    expect(navigation.value.find((entry) => entry.id === f.worker.runId)).toMatchObject({
      presentation: { snoozed: true, woke: false },
      attention: { needsInput: false, problem: false, matters: [] },
    });
  }),
);

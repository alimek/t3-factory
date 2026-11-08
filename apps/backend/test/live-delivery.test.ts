import { isDeepStrictEqual } from "node:util";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type {
  ConnectionLiveMessage,
  NavigationLiveMessage,
  RunLiveMessage,
} from "@t3-factory/contracts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import { factoryHarness } from "./support/factory.ts";
import { appliedRun, subscribe, withoutGeneration } from "./support/live.ts";
import { directWorker, finishWorker, workerFinal, workerWorking } from "./support/run-worker.ts";

const WORKING = "Opened PR #42; waiting for its CI checks.";

const showsWorking = (messages: readonly RunLiveMessage[]) =>
  appliedRun(messages)?.blocks[0]?.workingMessage === WORKING;

it("an accepted Block report reaches open Run and navigation subscribers without another read", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const run = subscribe(c, f.f.live.watchRun(f.runId));
  const navigation = subscribe(c, f.f.live.watchNavigation());
  await run.until((messages) => messages.length > 0);
  await navigation.until((messages) => messages.length > 0);

  // Act
  const reply = await f.f.runtime.submit(workerWorking(f.blockId));

  // Assert
  expect(reply.code).toBe("ACCEPTED");
  const delivered = await run.until(showsWorking);
  expect(delivered.filter((message) => message._tag === "snapshot")).toHaveLength(1);
  const rows = await navigation.until((messages) =>
    messages.some(
      (message: NavigationLiveMessage) =>
        message._tag === "changed" &&
        message.upserts.some((row) => row.blocks[0]?.workingMessage === WORKING),
    ),
  );
  expect(rows.filter((message) => message._tag === "snapshot")).toHaveLength(1);
});

it("a report on another Run sends nothing to an open Run's subscriber", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const other = await f.f.startRun({ ...f.input, requestId: "start-two", title: "Other work" });
  assert(other.ok);
  assert((await f.f.reconcileRuns()).ok);
  const unrelated = subscribe(c, f.f.live.watchRun(other.value.id));
  const related = subscribe(c, f.f.live.watchRun(f.runId));
  await unrelated.until((messages) => messages.length > 0);

  // Act
  const reply = await f.f.runtime.submit(workerWorking(f.blockId));

  // Assert
  expect(reply.code).toBe("ACCEPTED");
  await related.until(showsWorking);
  expect(unrelated.messages.map((message) => message._tag)).toStrictEqual(["snapshot"]);
});

it("an unchanged worker observation sends only its observation times", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const run = subscribe(c, f.f.live.watchRun(f.runId));
  await run.until((messages) => messages.length > 0);

  // Act
  const reconciled = await f.f.reconcileRuns();

  // Assert
  assert(reconciled.ok);
  const current = await f.f.getRun(f.runId);
  assert(current.ok);
  const delivered = await run.until((messages) =>
    isDeepStrictEqual(withoutGeneration(appliedRun(messages)), withoutGeneration(current.value)),
  );
  expect(delivered.map((message) => message._tag)).toStrictEqual(["snapshot", "observed"]);
});

it("a report committed while a Run subscription starts is delivered once", async (c) => {
  // Arrange
  const f = await directWorker(c);

  // Act
  const [run, reply] = await Promise.all([
    Promise.resolve(subscribe(c, f.f.live.watchRun(f.runId))),
    f.f.runtime.submit(workerWorking(f.blockId)),
  ]);

  // Assert
  expect(reply.code).toBe("ACCEPTED");
  const delivered = await run.until(showsWorking);
  const current = await f.f.getRun(f.runId);
  assert(current.ok);
  expect(withoutGeneration(appliedRun(delivered))).toStrictEqual(withoutGeneration(current.value));
});

it("watching a Run that does not exist fails with not_found", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open({ t3: new ControlledT3() });

  // Act
  const run = subscribe(c, factory.live.watchRun("missing-run"));

  // Assert
  const ended = await run.ended;
  assert(Exit.isFailure(ended));
  expect(Cause.findErrorOption(ended.cause)).toMatchObject({
    _tag: "Some",
    value: { code: "not_found" },
  });
});

it("a T3 connection change reaches connection subscribers without another read", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  t3.authorized = true;
  const factory = await (await factoryHarness(c)).open({ t3, connectionRetryMs: 60_000 });
  assert((await factory.configureConnection({ endpoint: "http://localhost:3773/mcp" })).ok);
  const connection = subscribe(c, factory.live.watchConnection());
  await connection.until((messages) => messages.length > 0);
  t3.available = false;

  // Act
  const rechecked = await factory.recheckConnection();

  // Assert
  assert(rechecked.ok);
  const delivered = await connection.until((messages) => messages.length > 1);
  expect(delivered[1]).toStrictEqual({
    _tag: "changed",
    connection: rechecked.value,
  } satisfies ConnectionLiveMessage);
});

it.effect("live subscribers neither multiply Runner observations nor own handoff progress", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* Effect.promise(() => directWorker(c));
    yield* Effect.promise(() => f.f.close());
    const factory = yield* f.h.service({ t3: f.t3, connectionRetryMs: 1000 });
    const beforeZero = f.t3.executionReads;
    yield* TestClock.adjust(1000);
    const zeroSubscriberReads = f.t3.executionReads - beforeZero;
    const first = subscribe(c, factory.live.watchRun(f.runId));
    const second = subscribe(c, factory.live.watchRun(f.runId));
    yield* Effect.promise(() => first.until((messages) => messages.length > 0));
    yield* Effect.promise(() => second.until((messages) => messages.length > 0));
    const beforeTwo = f.t3.executionReads;
    yield* TestClock.adjust(1000);
    const twoSubscriberReads = f.t3.executionReads - beforeTwo;
    yield* Effect.promise(() => first.stop());
    yield* Effect.promise(() => second.stop());
    const report = yield* factory.runtime.submit(workerFinal(f.blockId));
    assert(report.code === "ACCEPTED");
    finishWorker(f);
    const beforeHandoff = yield* factory.getRun(f.runId);
    assert(beforeHandoff.ok);
    expect(beforeHandoff.value.reports[0]?.completionEligibleAt).toBeNull();
    expect(f.t3.launches.size).toBe(1);

    // Act
    yield* TestClock.adjust(1000);

    // Assert
    expect(zeroSubscriberReads).toBe(1);
    expect(twoSubscriberReads).toBe(zeroSubscriberReads);
    const run = yield* factory.getRun(f.runId);
    assert(run.ok);
    expect(run.value.reports[0]?.completionEligibleAt).not.toBeNull();
    expect(run.value.activations.map((activation) => activation.blockId)).toStrictEqual([
      "worker",
      "parallel-block",
    ]);
    expect(f.t3.launches.size).toBe(2);
    expect(run.value.blocks.find((block) => block.blockId === "parallel-block")).toMatchObject({
      threadId: "thread-2",
    });
  }),
);

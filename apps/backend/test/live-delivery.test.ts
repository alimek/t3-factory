import { isDeepStrictEqual } from "node:util";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type {
  ConnectionLiveMessage,
  NavigationLiveMessage,
  RunLiveMessage,
} from "@t3-factory/contracts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import { factoryHarness } from "./support/factory.ts";
import {
  appliedRun,
  raceFirstRead,
  subscribe,
  watchNavigation,
  watchRun,
  withoutGeneration,
} from "./support/live.ts";
import {
  directWorker,
  finishWorker,
  startWorkerTurn,
  workerFinal,
  workerWorking,
} from "./support/run-worker.ts";

import { makeLiveChanges } from "../src/live-changes.ts";
import { makeLiveStreams } from "../src/live-streams.ts";

const WORKING = "Opened PR #42; waiting for its CI checks.";

const showsWorking = (messages: readonly RunLiveMessage[]) =>
  appliedRun(messages)?.blocks[0]?.workingMessage === WORKING;

it("an accepted Block report reaches open Run and navigation subscribers without another read", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const run = subscribe(c, watchRun(f.f.live, f.runId));
  const navigation = subscribe(c, watchNavigation(f.f.live));
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

it("a later turn preserves both executions of the same worker binding", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const run = subscribe(c, watchRun(f.f.live, f.runId));
  await run.until((messages) => messages.length > 0);
  startWorkerTurn(f, "reply-execution", 2);

  // Act
  const reconciled = await f.f.reconcileRuns();

  // Assert
  assert(reconciled.ok);
  const current = await f.f.getRun(f.runId);
  assert(current.ok);
  const delivered = await run.until((messages) => messages.length > 1);
  const executions = appliedRun(delivered)?.executions;
  expect(executions).toStrictEqual(current.value.executions);
  expect(executions?.map((execution) => execution.executionId)).toStrictEqual([
    "execution-1",
    "reply-execution",
  ]);
  expect(executions?.[0]?.bindingId).toBe(executions?.[1]?.bindingId);
});

it("a report on another Run sends nothing to an open Run's subscriber", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const other = await f.f.startRun({ ...f.input, requestId: "start-two", title: "Other work" });
  assert(other.ok);
  assert((await f.f.reconcileRuns()).ok);
  const unrelated = subscribe(c, watchRun(f.f.live, other.value.id));
  const related = subscribe(c, watchRun(f.f.live, f.runId));
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
  const run = subscribe(c, watchRun(f.f.live, f.runId));
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

it("the first Run snapshot includes a report committed during its read", async (c) => {
  // Arrange
  const f = await directWorker(c);

  const changes = makeLiveChanges();
  // Built once: the first execution of this read commits a report while it runs.
  const racedRead = raceFirstRead(
    Effect.promise(() => f.f.getRun(f.runId)),
    async () => {
      expect((await f.f.runtime.submit(workerWorking(f.blockId))).code).toBe("ACCEPTED");
      changes.runChanged(f.runId);
    },
  );
  const live = makeLiveStreams(
    changes,
    {
      getConnection: () => Effect.promise(() => f.f.getConnection()),
      listRunNavigation: () => Effect.promise(() => f.f.listRunNavigation()),
      getRun: () => racedRead,
    },
    (read) => read,
  );

  // Act
  const run = subscribe(c, watchRun(live, f.runId));

  // Assert
  const delivered = await run.until(showsWorking);
  expect(delivered[0]).toMatchObject({
    _tag: "snapshot",
    run: { blocks: expect.arrayContaining([expect.objectContaining({ workingMessage: WORKING })]) },
  });
  expect(run.envelopes[0]?.current).toBe(true);
  const current = await f.f.getRun(f.runId);
  assert(current.ok);
  expect(withoutGeneration(appliedRun(delivered))).toStrictEqual(withoutGeneration(current.value));
});

it("a snapshot raced on every read is not current until its catch-up is delivered", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const changes = makeLiveChanges();
  let racedReads = 0;
  const live = makeLiveStreams(
    changes,
    {
      getConnection: () => Effect.promise(() => f.f.getConnection()),
      listRunNavigation: () => Effect.promise(() => f.f.listRunNavigation()),
      getRun: () =>
        Effect.promise(() => f.f.getRun(f.runId)).pipe(
          Effect.tap(() =>
            racedReads++ < 3
              ? Effect.promise(async () => {
                  expect((await f.f.renameRun(f.runId, { title: `Raced ${racedReads}` })).ok).toBe(
                    true,
                  );
                  changes.runChanged(f.runId);
                })
              : Effect.void,
          ),
        ),
    },
    (read) => read,
  );

  // Act
  const run = subscribe(c, watchRun(live, f.runId));

  // Assert
  await run.until(() => run.envelopes.some((envelope) => envelope.current));
  expect(run.envelopes[0]?.current).toBe(false);
  expect(appliedRun(run.messages)?.title).toBe("Raced 3");
});

it("a Run that does not exist is reported missing while the rest of its view stays live", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open({ t3: new ControlledT3() });

  // Act
  const view = subscribe(
    c,
    factory.live.watchRunView({ navigation: true, runIds: ["missing-run"] }),
  );

  // Assert
  const [snapshot] = await view.until((messages) => messages.length > 1);
  expect(view.messages).toMatchObject([
    { _tag: "navigation", message: { _tag: "snapshot", rows: [] } },
    { _tag: "missing", runId: "missing-run", error: { code: "not_found" } },
  ]);
  expect(snapshot).toBeDefined();
  expect(view.envelopes[0]?.current).toBe(true);
});

it("one commit's Run and navigation changes arrive in the same envelope", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const view = subscribe(c, f.f.live.watchRunView({ navigation: true, runIds: [f.runId] }));
  await view.until((messages) => messages.length > 0);

  // Act
  expect((await f.f.runtime.submit(workerWorking(f.blockId))).code).toBe("ACCEPTED");

  // Assert
  const reported = (envelope: (typeof view.envelopes)[number]) =>
    envelope.messages.some(
      (message) => message._tag === "run" && message.message._tag === "changed",
    );
  await view.until(() => view.envelopes.some(reported));
  const together = view.envelopes.find(reported);
  expect(together?.messages.map((message) => message._tag).sort()).toStrictEqual([
    "navigation",
    "run",
  ]);
});

it("a re-read raced by another commit is not current until its catch-up arrives", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const changes = makeLiveChanges();
  let reads = 0;
  const live = makeLiveStreams(
    changes,
    {
      getConnection: () => Effect.promise(() => f.f.getConnection()),
      listRunNavigation: () => Effect.promise(() => f.f.listRunNavigation()),
      getRun: () =>
        Effect.promise(() => f.f.getRun(f.runId)).pipe(
          Effect.tap(() =>
            reads++ === 1
              ? Effect.promise(async () => {
                  expect((await f.f.renameRun(f.runId, { title: "Raced later" })).ok).toBe(true);
                  changes.runChanged(f.runId);
                })
              : Effect.void,
          ),
        ),
    },
    (read) => read,
  );
  const run = subscribe(c, watchRun(live, f.runId));
  await run.until((messages) => messages.length > 0);

  // Act
  expect((await f.f.runtime.submit(workerWorking(f.blockId))).code).toBe("ACCEPTED");
  changes.runChanged(f.runId);

  // Assert
  await run.until((messages) => appliedRun(messages)?.title === "Raced later");
  expect(run.envelopes.map((envelope) => envelope.current)).toStrictEqual([true, false, true]);
});

it("a failed re-read marks the view not current until a later read succeeds", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const changes = makeLiveChanges();
  let reads = 0;
  const live = makeLiveStreams(
    changes,
    {
      getConnection: () => Effect.promise(() => f.f.getConnection()),
      listRunNavigation: () => Effect.promise(() => f.f.listRunNavigation()),
      getRun: () =>
        reads++ === 1
          ? Effect.succeed({
              ok: false as const,
              error: { code: "internal" as const, message: "Storage is busy.", issues: [] },
            })
          : Effect.promise(() => f.f.getRun(f.runId)),
    },
    (read) => read,
  );
  const run = subscribe(c, watchRun(live, f.runId));
  await run.until((messages) => messages.length > 0);

  // Act
  expect((await f.f.runtime.submit(workerWorking(f.blockId))).code).toBe("ACCEPTED");
  changes.runChanged(f.runId);

  // Assert
  await run.until(showsWorking);
  expect(run.envelopes.map((envelope) => envelope.current)).toStrictEqual([true, false, true]);
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
    const first = subscribe(c, watchRun(factory.live, f.runId));
    const second = subscribe(c, watchRun(factory.live, f.runId));
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

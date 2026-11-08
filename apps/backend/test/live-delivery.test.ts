import { isDeepStrictEqual } from "node:util";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import type {
  ConnectionLiveMessage,
  NavigationLiveMessage,
  RunLiveMessage,
} from "@t3-factory/contracts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import { factoryHarness } from "./support/factory.ts";
import { appliedRun, subscribe, withoutGeneration } from "./support/live.ts";
import { directWorker, workerWorking } from "./support/run-worker.ts";

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

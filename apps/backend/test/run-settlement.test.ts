import { assert, expect, it } from "@effect/vitest";
import { nextSettlement, reopenDuringSettlement } from "./support/run-worker.ts";
import {
  allTurnsEnd,
  archived,
  blockExit,
  finishedReport,
  handoffFlow,
  missingReport,
  report,
  resultReleasedToSameWorker,
  resultReleasedToSecondWorker,
  resultReplacedBeforeRelease,
  resultReported,
  sentTurnBegins,
  settled,
  snoozed,
  turnBegins,
  workerAtWork,
  workerFinal,
  workerWorking,
  workingReport,
} from "./support/scenarios.ts";
import { prepared } from "./support/prepared-runner.ts";
import { answerDelegatedWait } from "./support/controlled-thread.ts";

it("a finished terminal Block settles its worker thread in T3 without waiting for Run settlement", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("a replaced finished report in the same T3 run is not settled again", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const replaced = await resultReplacedBeforeRelease(setup.world, atWork);
  await resultReleasedToSecondWorker(setup.world, replaced);
  const f = { ...setup, ...replaced, worker: replaced };

  assert((await report(f.world, f.worker, finishedReport("Another pass."))) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("a revisited Block settles its thread again after a new T3 run finishes", async (c) => {
  // Arrange
  // The second result leaves on Ship, which has no recipient, so no later visit can race the
  // settlement sweep for the thread.
  const setup = await prepared(c, {
    revisit: true,
    exits: [blockExit("done", "Done", "Completed"), blockExit("ship", "Ship")],
  });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const released = await resultReleasedToSameWorker(setup.world, reported);
  const worker = sentTurnBegins(setup.world, released);
  const f = { ...setup, ...worker };
  await f.f.reconcileRuns();
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
  assert((await report(f.world, worker, finishedReport("Second pass.", "ship"))) === "ACCEPTED");
  const runBeforeFinish = await f.f.getRun(f.runId);
  assert(runBeforeFinish.ok);
  const producingExecution = runBeforeFinish.value.reports.at(-1)?.executionId;
  assert(producingExecution);
  expect(producingExecution).toBe(worker.executionId);
  allTurnsEnd(f.world, worker);
  answerDelegatedWait(f.t3, "thread-1", worker.executionId, "settled", "completed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements.map((entry) => entry.threadId)).toStrictEqual(["thread-1", "thread-1"]);
});

it("a finished Block on a snoozed Run still settles its worker thread", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const f = { ...setup, ...(await snoozed(setup.world, reported)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("an open missing-report Problem leaves the worker thread unsettled", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await missingReport(setup.world, atWork)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a Block whose latest report is working leaves its worker thread unsettled", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  assert((await report(f.world, worker, workingReport())) === "ACCEPTED");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("Run settlement does not request a thread the per-Block pass already settled", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };

  assert((await f.f.reconcileRuns()).ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("an archived Run receives no per-Block thread settlement", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const f = { ...setup, ...(await archived(setup.world, reported)) };
  f.t3.settlements.length = 0;

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("per-Block settlement is a no-op when T3 lacks native settle support", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  f.t3.settleSupported = false;

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a failed per-Block T3 thread settlement leaves the Run unchanged", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  f.t3.settleThread = () => Promise.reject(Error("T3 could not settle the thread"));

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
});

it("a finished handoff Block settles its worker thread in T3 while the Run stays Active", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("a Run settles automatically once its reported worker's thread is finished", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(run.value.events.at(-1)).toMatchObject({ kind: "run-settled", causeId: "automatic" });
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
  const navigation = await f.f.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value.map((entry) => entry.lifecycle)).toStrictEqual(["settled"]);
});

it("a Run stays Active while T3 has not answered that its worker's delegated work settled", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  f.t3.delegatedSettlements.delete(JSON.stringify(["thread-1", "execution-1"]));

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a failed T3 thread settlement leaves the Run Settled", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  f.t3.settleThread = () => Promise.reject(Error("T3 could not settle the thread"));

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
  expect(run.value.events.at(-1)?.kind).toBe("run-settled");
});

it("settling an Active Run leaves its running work alone and settles the worker thread in T3", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const f = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };
  const settlement = nextSettlement(f.t3);

  // Act
  const result = await f.f.settleRun(f.runId);

  // Assert
  assert(result.ok);
  expect(result.value.lifecycle).toBe("settled");
  expect(result.value.events.at(-1)).toMatchObject({ kind: "run-settled", causeId: "manual" });
  expect(result.value.blocks[0]?.state).toBe("working");
  expect(result.value.gateOpen).toBe(true);
  await settlement;
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("settling a snoozed Run moves it out of Snoozed", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await snoozed(setup.world, atWork)) };

  // Act
  const result = await f.f.settleRun(f.runId);

  // Assert
  assert(result.ok);
  const navigation = await f.f.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value[0]).toMatchObject({
    lifecycle: "settled",
    presentation: { snoozed: false, woke: false },
  });
});

it("a Settled Run cannot be snoozed", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const f = { ...setup, ...(await settled(setup.world, reported)) };

  // Act
  const result = await f.f.snoozeRun(f.runId);

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("conflict");
});

it("a working report from a Block of a Settled Run returns the Run to Active", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const f = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };
  assert((await f.f.settleRun(f.runId)).ok);

  // Act
  const result = await f.f.runtime.submit(workerWorking(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(run.value.events.at(-1)).toMatchObject({ kind: "run-activated", blockId: "worker" });
});

it("repeating the current result on a Settled Run returns the Run to Active", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const f = { ...setup, ...(await settled(setup.world, reported)) };

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(run.value.reports).toHaveLength(1);
});

it("repeating the earlier result after a working report makes it current, so the Run settles once its worker thread is finished", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  assert((await report(f.world, worker, finishedReport())) === "ACCEPTED");
  assert((await report(f.world, worker, workingReport())) === "ACCEPTED");
  assert((await report(f.world, worker, finishedReport())) === "ACCEPTED");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(run.value.blocks[0]).toMatchObject({ state: "finished", workingMessage: null });
});

it("a reply turn in a worker thread without a report leaves the Settled Run Settled", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const worker = await settled(setup.world, reported);
  const f = { ...setup, ...worker };
  turnBegins(f.world, worker, "chat-execution");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(run.value.executions.map((e) => e.executionId)).not.toContain("chat-execution");
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});

it("an execution-failed Problem prevents settling a Block with a finished report", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork, { status: "failed" })) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.filter((a) => !a.settledAt).map((a) => a.kind)).toContain(
    "execution-failed",
  );
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a working report accepted during the completion read prevents stale settlement", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await resultReported(setup.world, atWork);
  const f = { ...setup, ...worker };
  reopenDuringSettlement(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]?.workingMessage).toBe("Opened PR #42; waiting for its CI checks.");
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a newer active turn prevents settlement for an older finished result", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await resultReported(setup.world, atWork);
  const f = { ...setup, ...worker };
  turnBegins(f.world, worker, "newer-execution");

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a newer idle turn with pending delegated work prevents settlement for an older result", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await resultReported(setup.world, atWork);
  const f = { ...setup, ...worker };
  turnBegins(f.world, worker, "newer-execution");
  allTurnsEnd(f.world, worker);
  answerDelegatedWait(f.t3, "thread-1", "newer-execution", "pending", "completed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a newer completed turn is settled once by the Run fallback rather than an older Block result", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await resultReported(setup.world, atWork);
  const f = { ...setup, ...worker };
  turnBegins(f.world, worker, "newer-execution");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

import { assert, expect, it } from "@effect/vitest";
import {
  directWorker,
  finishWorker,
  finishedTerminalWorker,
  finishedWorker,
  nextSettlement,
  reportedWorker,
  revisitReportingWorker,
  settledWorker,
  startWorkerTurn,
  workerFinal,
  workerWorking,
} from "./support/run-worker.ts";

it("a Run settles automatically once its reported worker's thread is finished", async (c) => {
  // Arrange
  const f = await finishedWorker(c);

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
  const f = await finishedWorker(c);
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
  const f = await finishedWorker(c);
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
  const f = await directWorker(c);
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
  const f = await directWorker(c);
  assert((await f.f.snoozeRun(f.runId)).ok);

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
  const f = await settledWorker(c);

  // Act
  const result = await f.f.snoozeRun(f.runId);

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("conflict");
});

it("a working report from a Block of a Settled Run returns the Run to Active", async (c) => {
  // Arrange
  const f = await directWorker(c);
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
  const f = await settledWorker(c);

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
  const f = await directWorker(c, true, "");
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  finishWorker(f);

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
  const f = await settledWorker(c);
  startWorkerTurn(f, "chat-execution", 2);
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(run.value.executions.map((e) => e.executionId)).not.toContain("chat-execution");
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});

it("a worker thread is settled in T3 once its Block's handoff result is confirmed finished, while the Run stays Active", async (c) => {
  // Arrange
  const f = await reportedWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("a terminal Block's worker thread is settled in T3 once finished without waiting for Run settlement", async (c) => {
  // Arrange
  const f = await finishedTerminalWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }, { threadId: "thread-2" }]);
});

it("a result replaced in the same T3 run does not settle the worker thread again", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  assert((await f.f.runtime.submit(workerFinal(f.blockId, "Updated result."))).code === "ACCEPTED");

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("a result replaced by a newer T3 run during the thread read is settled once, for the newer run", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  const inspectSettleSupport = f.t3.inspectSettleSupport.bind(f.t3);
  const readExecution = f.t3.readExecution.bind(f.t3);
  // Arm after observation, when settlement has selected the old result as its candidate.
  f.t3.inspectSettleSupport = async (target) => {
    f.t3.inspectSettleSupport = inspectSettleSupport;
    f.t3.readExecution = async (target, threadId) => {
      f.t3.readExecution = readExecution;
      const thread = await readExecution(target, threadId);
      startWorkerTurn(f, "chat-execution", 2);
      const replacement = await f.f.runtime.submit(workerFinal(f.blockId, "Updated result."));
      assert(replacement.code === "ACCEPTED");
      finishWorker(f);
      // A repeated report observes the finished turn before the stale read returns.
      assert(
        (await f.f.runtime.submit(workerFinal(f.blockId, "Updated result."))).code === "ACCEPTED",
      );
      return thread;
    };
    return inspectSettleSupport(target);
  };

  // Act
  await f.f.reconcileRuns();
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
});

it("a failed per-Block T3 thread settlement keeps the Run Active and its result", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  let settleAttempts = 0;
  f.t3.settleThread = () => {
    settleAttempts++;
    return Promise.reject(Error("T3 could not settle the thread"));
  };

  // Act
  await f.f.reconcileRuns();
  const run = await f.f.getRun(f.runId);
  const attemptsAfterFailure = settleAttempts;
  await f.f.reconcileRuns();

  // Assert
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(attemptsAfterFailure).toBe(1);
  expect(settleAttempts).toBe(1);
  expect(run.value.blocks[0]).toMatchObject({
    state: "finished",
    reportStatus: "finished",
    workingMessage: null,
  });
  expect(run.value.reports).toMatchObject([
    { blockId: "worker", status: "finished", resultMessage: "Implemented the requested result." },
  ]);
});

it("a revisited Block's worker thread is settled again once its new T3 run finishes", async (c) => {
  // Arrange
  const f = await revisitReportingWorker(c);
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([{ threadId: "thread-1" }, { threadId: "thread-1" }]);
});

it("a worker thread whose latest T3 run did not produce the Block's result is not settled per Block", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  startWorkerTurn(f, "chat-execution", 2);
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(f.t3.settlements).toStrictEqual([]);
});

it("a working report after the result keeps the finished worker thread unsettled in T3", async (c) => {
  // Arrange
  const f = await directWorker(c);
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.settlements).toStrictEqual([]);
});

it("an execution failure on a reported Block keeps its worker thread unsettled in T3", async (c) => {
  // Arrange
  const f = await reportedWorker(c, "failed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => !a.settledAt)?.kind).toBe("execution-failed");
  expect(f.t3.settlements).toStrictEqual([]);
});

it("without native settle support a finished worker thread is not settled per Block", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  f.t3.settleSupported = false;

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("active");
  expect(f.t3.settlements).toStrictEqual([]);
});

import { assert, expect, it } from "@effect/vitest";
import {
  askedAfterResult,
  directWorker,
  finishWorker,
  launchedBlockId,
  releasedTwoExitWorker,
  replacedBeforeRelease,
  reportedWorker,
  settleThread,
  startWorkerTurn,
  workerFinal,
  workerWorking,
} from "./support/run-worker.ts";

it("a newer finished report before release replaces the held result and only it is handed off", async (c) => {
  // Arrange
  const f = await replacedBeforeRelease(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker", "parallel-block"]);
  expect(run.value.intents.map(({ reportId, state }) => ({ reportId, state }))).toStrictEqual([
    { reportId: null, state: "acknowledged" },
    { reportId: run.value.reports[0]?.id, state: "cancelled" },
    { reportId: run.value.reports[1]?.id, state: "acknowledged" },
  ]);
  expect(f.t3.launches.size).toBe(2);
  const next = await f.f.runtime.block({
    arguments: { blockId: launchedBlockId(f.t3, "Parallel work") },
  });
  expect(next.inputs?.results).toMatchObject([{ message: "Final result." }]);
});

it("a Run whose result was replaced before handoff settles once every worker is done", async (c) => {
  // Arrange
  const f = await replacedBeforeRelease(c);
  assert((await f.f.reconcileRuns()).ok);
  const next = workerFinal(launchedBlockId(f.t3, "Parallel work"));
  assert((await f.f.runtime.submit(next)).code === "ACCEPTED");
  f.t3.engineStatus = "completed";
  settleThread(f.t3, "execution-2", "completed", "settled", "thread-2");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
});

it("after release a same-exit finished report updates the result without relaunching the next Block", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  startWorkerTurn(f, "followup-execution", 2);

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId, "Updated result."));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  const versions = run.value.reports.map((report) => report.id);
  expect(
    run.value.events.filter((e) => e.kind === "report-accepted").map((e) => e.causeId),
  ).toStrictEqual(versions);
  expect(run.value.intents.filter((i) => i.reportId === versions[1])).toStrictEqual([]);
  const view = await f.f.runtime.run({ arguments: { blockId: f.blockId } });
  expect(view.blocks?.find((block) => block.blockId === "worker")?.result).toBe("Updated result.");
  expect(f.t3.launches.size).toBe(2);
});

it("after release a different-exit finished report hands off to that exit's Block while the earlier one keeps running", async (c) => {
  // Arrange
  const f = await releasedTwoExitWorker(c);
  const revised = workerFinal(f.blockId, "Needs another pass.", "Revise");
  assert((await f.f.runtime.submit(revised)).code === "ACCEPTED");
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual([
    "worker",
    "parallel-block",
    "follow-up",
  ]);
  expect([...f.t3.launches.values()].map((launch) => launch.payload.title)).toStrictEqual([
    "Factory #1 · 1 Entry worker",
    "Factory #1 · 2 Parallel work",
    "Factory #1 · 3 Follow-up",
  ]);
  expect(run.value.blocks.find((block) => block.blockId === "parallel-block")?.state).toBe(
    "working",
  );
  expect(f.t3.threadStops).toStrictEqual([]);
});

it("a different-exit result after release stays held while the worker thread is still running", async (c) => {
  // Arrange
  const f = await releasedTwoExitWorker(c);
  const revised = workerFinal(f.blockId, "Needs another pass.", "Revise");
  assert((await f.f.runtime.submit(revised)).code === "ACCEPTED");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.intents.find((i) => i.blockId === "follow-up")?.state).toBe("pending");
  expect(f.t3.launches.size).toBe(2);
});

it("repeating the result from a later turn settles an execution failure recorded after it", async (c) => {
  // Arrange
  const f = await reportedWorker(c, "failed");
  assert((await f.f.reconcileRuns()).ok);
  startWorkerTurn(f, "retry-execution", 2);

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => a.kind === "execution-failed")).toMatchObject({
    settledAt: expect.any(String),
    settlementReason: "report-accepted",
  });
  expect(run.value.reports).toHaveLength(2);
});

it("a finished report settles the question the worker asked after its earlier result", async (c) => {
  // Arrange
  const f = await askedAfterResult(c);

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId, "Updated the docs as well."));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => a.kind === "conversation-waiting")).toMatchObject({
    settledAt: expect.any(String),
    settlementReason: "completed",
  });
  expect(run.value.reports.map((report) => report.resultMessage)).toStrictEqual([
    "Implemented the requested result.",
    "Updated the docs as well.",
  ]);
});

it("a question asked after a result keeps the Block waiting once its worker thread is finished", async (c) => {
  // Arrange
  const f = await askedAfterResult(c);
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]?.state).toBe("waiting");
  expect(
    run.value.attention.filter((a) => a.kind === "conversation-waiting" && !a.settledAt),
  ).toMatchObject([{ message: "Should I update the docs too?" }]);
  expect(run.value.lifecycle).toBe("active");
});

it("a working report after a result keeps the Block working and its Run Active once its worker thread is finished", async (c) => {
  // Arrange
  const f = await directWorker(c, true, "");
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
  finishWorker(f);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
  expect(run.value.reports).toMatchObject([{ status: "finished" }]);
  expect(run.value.lifecycle).toBe("active");
});

import { assert, expect, it } from "@effect/vitest";
import { launchedBlockId } from "./support/run-worker.ts";
import {
  allTurnsEnd,
  finishedReport,
  handoffFlow,
  laterTurnAfterRelease,
  report,
  resultReleasedToSecondWorker,
  resultReplacedBeforeRelease,
  resultReported,
  turnBegins,
  twoExitFlow,
  workerAtWork,
  workerFinal,
  workingReport,
} from "./support/scenarios.ts";
import { prepared } from "./support/prepared-runner.ts";

it("a newer finished report before release replaces the held result and only it is handed off", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReplacedBeforeRelease(setup.world, atWork)) };

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
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const replaced = await resultReplacedBeforeRelease(setup.world, atWork);
  const next = await resultReleasedToSecondWorker(setup.world, replaced);
  const f = { ...setup, ...(await resultReported(setup.world, next)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
});

it("after release a same-exit finished report updates the result without relaunching the next Block", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const f = { ...setup, ...(await laterTurnAfterRelease(setup.world, reported)) };

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
  const setup = await prepared(c, twoExitFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const worker = await laterTurnAfterRelease(setup.world, reported);
  const f = { ...setup, ...worker, worker };
  const revised = finishedReport("Needs another pass.", "Revise");
  assert((await report(f.world, f.worker, revised)) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);

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
  const setup = await prepared(c, twoExitFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const worker = await laterTurnAfterRelease(setup.world, reported);
  const f = { ...setup, ...worker, worker };
  const revised = finishedReport("Needs another pass.", "Revise");
  assert((await report(f.world, f.worker, revised)) === "ACCEPTED");

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
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await resultReported(setup.world, atWork, {
    status: "failed",
  });
  const f = { ...setup, ...worker };
  assert((await f.f.reconcileRuns()).ok);
  turnBegins(f.world, worker, "retry-execution");

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

it("a working report after a result keeps the Block working and its Run Active once its worker thread is finished", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  assert((await report(f.world, worker, finishedReport())) === "ACCEPTED");
  assert((await report(f.world, worker, workingReport())) === "ACCEPTED");
  allTurnsEnd(f.world, worker);

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

import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { workerStart } from "./support/run-worker.ts";
import {
  allTurnsEnd,
  finishedReport,
  missingReport,
  report,
  reportRecoveryRequested,
  reportRejected,
  workerAtWork,
  workerFinal,
} from "./support/scenarios.ts";
import { answerDelegatedWait } from "./support/controlled-thread.ts";

it("a rejected worker report explains the rejection without changing execution state or retaining its message", async (c) => {
  // Arrange
  const setup = await workerStart(c);
  const f = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await f.f.runtime.submit({
    arguments: {
      blockId: f.blockId,
      to: "finished",
      exit: "unknown",
      message: "PRIVATE_REPORT_CONTENT",
    },
  });

  // Assert
  expect(result).toMatchObject({
    code: "INVALID_EXIT",
    reason: expect.any(String),
    next: expect.any(String),
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    engineStatus: "running",
    problem: null,
  });
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({
      kind: "report-problem",
      executionId: "execution-1",
      settledAt: null,
      message: expect.stringContaining("INVALID_EXIT"),
    }),
  );
  expect(JSON.stringify(run.value)).not.toContain("PRIVATE_REPORT_CONTENT");
  expect(run.value.reports).toStrictEqual([]);
  expect(f.t3.sends.size).toBe(0);
});

it("a corrected accepted report settles its rejection Problem", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await reportRejected(setup.world, atWork)) };

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({
      kind: "report-problem",
      settledAt: expect.any(String),
      settlementReason: "report-accepted",
    }),
  );
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});

it("a rejected report remains explained after completion and backend restart", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const rejected = await reportRejected(setup.world, atWork);
  const f = { ...setup, ...(await missingReport(setup.world, rejected)) };
  await f.f.close();

  // Act
  const factory = await f.h.open({ t3: f.t3 });

  // Assert
  const run = await factory.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({
      kind: "report-problem",
      settledAt: null,
      message: expect.stringContaining("INVALID_EXIT"),
    }),
  );
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({ kind: "missing-report", settledAt: null }),
  );
  expect(f.t3.sends.size).toBe(0);
});

it("Request report refuses a stale missing-report Problem while delegated work is unsettled", async (c) => {
  // Arrange
  const setup = await workerStart(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await missingReport(setup.world, atWork)) };
  answerDelegatedWait(f.t3, "thread-1", "execution-1", "pending", "completed");

  // Act
  const result = await f.f.requestReport(f.runId, { blockId: f.missing.blockId });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("conflict");
  expect(f.t3.sends.size).toBe(0);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.recoveries).toStrictEqual([]);
});

it("repeated rejected reports keep one pending diagnostic without launching work", async (c) => {
  // Arrange
  const setup = await workerStart(c);
  const f = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };
  const invalid = { arguments: { blockId: f.blockId, to: "finished", exit: "unknown" } };
  assert((await f.f.runtime.submit(invalid)).code === "INVALID_EXIT");

  // Act
  const result = await f.f.runtime.submit(invalid);

  // Assert
  expect(result.code).toBe("INVALID_EXIT");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(
    run.value.attention.filter((a) => a.kind === "report-problem" && !a.settledAt),
  ).toHaveLength(1);
  expect(f.t3.sends.size).toBe(0);
});

it("successful linked recovery settles the original rejection while preserving its diagnostic history", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const rejected = await reportRejected(setup.world, atWork);
  const missing = await missingReport(setup.world, rejected);
  const worker = await reportRecoveryRequested(setup.world, missing);
  const f = { ...setup, ...worker };
  assert((await report(f.world, worker, finishedReport())) === "ACCEPTED");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({
      kind: "report-problem",
      settledAt: expect.any(String),
      message: expect.stringContaining("INVALID_EXIT"),
    }),
  );
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
  expect(run.value.lifecycle).toBe("settled");
});

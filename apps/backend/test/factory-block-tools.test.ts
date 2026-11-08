import { assert, expect, it } from "@effect/vitest";
import { uncertainLaunch } from "./support/lost-launch.ts";
import {
  directWorker,
  launchedBlockId,
  repliedWorker,
  reportedWorker,
  revisitReportingWorker,
  workerFinal,
  workerStart,
  workerWorking,
} from "./support/run-worker.ts";

it("factory_get_block reads the Block named by the id in its launch message", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    state: "working",
    visit: 1,
    reason: "first",
    exits: [{ id: "done", name: "Done", requiresFeedback: false }],
    inputs: {
      input: "Improve search\nKeep it accessible.",
      results: [],
      feedback: null,
    },
    allowedTransitions: ["working", "waiting", "finished"],
  });
});

it("the launch message states the Block id and issues no tool ref", async (c) => {
  // Arrange
  const fixture = await workerStart(c, "");
  assert((await fixture.f.startRun(fixture.input)).ok);

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  const message = [...fixture.t3.launches.values()][0]?.payload.message;
  expect(message).toMatch(/^\$factory-block\n\nFactory Block id: [0-9a-f-]{36}\. /);
  expect(message).not.toContain("Factory tool ref");
});

it("a call without a Block id is refused with repair guidance", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.block({ arguments: {} });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK_ID_REQUIRED",
    next: expect.stringContaining("Factory Block id line"),
  });
});

it("an unknown Block id is refused with repair guidance", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { ...workerFinal("not-a-block").arguments },
  });

  // Assert
  expect(result).toMatchObject({
    code: "UNKNOWN_BLOCK",
    reason: "No Factory Block has this Block id.",
    next: expect.stringContaining("Factory Block id line"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
  expect(run.value.attention).toStrictEqual([]);
});

it("a worker reads its Block while Factory is still confirming its launch", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c, false);

  // Act
  const result = await fixture.f.runtime.block({
    arguments: { blockId: launchedBlockId(fixture.t3) },
  });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", visit: 1, reason: "first" });
});

it("a worker resumed by the user's reply reads its Block and may report again", async (c) => {
  // Arrange
  const fixture = await repliedWorker(c);

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    visit: 1,
    allowedTransitions: ["working", "waiting", "finished"],
  });
});

it("a downstream worker retrieves its incoming result and the Block that produced it", async (c) => {
  // Arrange
  const fixture = await reportedWorker(c);
  assert((await fixture.f.reconcileRuns()).ok);

  // Act
  const result = await fixture.f.runtime.block({
    arguments: { blockId: launchedBlockId(fixture.t3, "Parallel work") },
  });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    inputs: {
      input: fixture.input.input,
      results: [
        {
          blockId: "worker",
          blockName: "Entry worker",
          exitName: "Done",
          message: workerFinal(fixture.blockId).arguments.message,
          threadLink: expect.any(String),
        },
      ],
    },
  });
});

it("a revisit message states the same Block id as the launch", async (c) => {
  // Arrange
  const fixture = await reportedWorker(c, "completed", "worker");

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  expect([...fixture.t3.sends.values()][0]?.payload.message).toContain(
    `Factory Block id: ${fixture.blockId}.`,
  );
});

it("a revisit's report applies to the Block's current activation", async (c) => {
  // Arrange
  const fixture = await revisitReportingWorker(c);

  // Act
  const result = await fixture.f.runtime.submit(workerFinal(fixture.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(2);
  expect(run.value.reports.map((report) => report.activationId)).toStrictEqual(
    run.value.activations.map((activation) => activation.id),
  );
});

it("a revisit reads only the result that activated it rather than its own newer result", async (c) => {
  // Arrange
  const fixture = await revisitReportingWorker(c);
  assert((await fixture.f.runtime.submit(workerFinal(fixture.blockId))).code === "ACCEPTED");
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result.code).toBe("BLOCK");
  expect(result.inputs?.results).toMatchObject([{ reportId: run.value.reports[0]?.id }]);
  expect(result.inputs?.results).toHaveLength(1);
});

it("factory_get_run returns the Run of the named Block and each Block's state", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.run({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "RUN",
    number: 1,
    title: "Improve search",
    input: "Improve search\nKeep it accessible.",
    state: "running",
    blocks: [{ blockId: "worker", name: "Entry worker", state: "working", result: null }],
  });
});

it("a worker reports its result by naming its Block id", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit(workerFinal(fixture.blockId));

  // Assert
  expect(result).toMatchObject({
    code: "ACCEPTED",
    state: "working",
    allowedTransitions: [],
    next: "Factory keeps this final and releases downstream work after this thread and its delegated work settle.",
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.reports).toMatchObject([
    { blockId: "worker", status: "finished", exitId: "done" },
  ]);
});

it("an identical repeated final succeeds again without a second result", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  const first = await fixture.f.runtime.submit(workerFinal(fixture.blockId));
  assert(first.code === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit(workerFinal(fixture.blockId));

  // Assert
  expect(result).toStrictEqual(first);
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.reports).toHaveLength(1);
});

it("a waiting Block update tells the worker to wait for a user reply", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "waiting", message: "Which audience?" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "ACCEPTED",
    state: "waiting",
    allowedTransitions: ["working", "waiting", "finished"],
    next: expect.stringContaining("waits for a user reply"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks.find((block) => block.blockId === "worker")?.state).toBe("waiting");
});

it("an identical repeated waiting report keeps one pending question", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  const waiting = {
    arguments: { blockId: fixture.blockId, to: "waiting", message: "Which audience?" },
  };
  const first = await fixture.f.runtime.submit(waiting);
  assert(first.code === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit(waiting);

  // Assert
  expect(result).toStrictEqual(first);
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.attention.filter((a) => a.kind === "conversation-waiting")).toHaveLength(1);
});

it("a newer waiting report replaces the Block's question", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  const first = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "waiting", message: "Which audience?" },
  });
  assert(first.code === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "waiting", message: "Which tone?" },
  });

  // Assert
  expect(result).toMatchObject({ code: "ACCEPTED", state: "waiting" });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(
    run.value.attention
      .filter((a) => a.kind === "conversation-waiting")
      .map(({ message, settledAt }) => ({ message, settled: settledAt !== null })),
  ).toStrictEqual([
    { message: "Which tone?", settled: false },
    { message: "Which audience?", settled: true },
  ]);
});

it("a working Block update is accepted with its message and selects no result", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: {
      blockId: fixture.blockId,
      to: "working",
      message: "Opened PR #42; waiting for its CI checks.",
    },
  });

  // Assert
  expect(result).toMatchObject({
    code: "ACCEPTED",
    state: "working",
    allowedTransitions: ["working", "waiting", "finished"],
    next: expect.stringContaining("no missing-report Problem"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    reportStatus: "working",
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
  expect(run.value.reports).toStrictEqual([]);
});

it("a later finished report replaces the Block's working report", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  assert((await fixture.f.runtime.submit(workerWorking(fixture.blockId))).code === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit(workerFinal(fixture.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ reportStatus: "finished", workingMessage: null });
  expect(run.value.reports).toMatchObject([{ status: "finished", exitId: "done" }]);
});

it("a later waiting report replaces the Block's working report with a question", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  assert((await fixture.f.runtime.submit(workerWorking(fixture.blockId))).code === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "waiting", message: "Merge with failing lint?" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ state: "waiting", workingMessage: null });
  expect(
    run.value.attention.filter((a) => a.kind === "conversation-waiting" && !a.settledAt),
  ).toMatchObject([{ message: "Merge with failing lint?" }]);
});

it("a working report without a message is refused with repair guidance", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "working", message: "  " },
  });

  // Assert
  expect(result).toMatchObject({
    code: "MESSAGE_REQUIRED",
    reason: expect.stringContaining("needs a message"),
    next: expect.stringContaining("what you are still doing or waiting on"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ reportStatus: null, workingMessage: null });
});

it("a working report that selects an exit is refused with repair guidance", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: {
      blockId: fixture.blockId,
      to: "working",
      exit: "Done",
      message: "Waiting for CI.",
    },
  });

  // Assert
  expect(result).toMatchObject({
    code: "EXIT_NOT_ALLOWED",
    reason: expect.stringContaining("Only a finished report selects an exit"),
    next: expect.stringContaining("Remove the exit"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ reportStatus: null, workingMessage: null });
});

it("an unknown exit names the exits captured for that Block", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: {
      blockId: fixture.blockId,
      to: "finished",
      exit: "nope",
      message: "Tried another exit.",
    },
  });

  // Assert
  expect(result).toMatchObject({ code: "INVALID_EXIT", allowedExits: ["Done"] });
});

it("a finished report without a message is accepted when that exit does not require feedback", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "finished", exit: "Done" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
});

it("a finished report without a message is refused when that exit requires feedback", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "", true);

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "finished", exit: "Done" },
  });

  // Assert
  expect(result).toMatchObject({ code: "FEEDBACK_REQUIRED" });
});

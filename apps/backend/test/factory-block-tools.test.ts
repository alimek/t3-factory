import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { launchedBlockId, workerMessage } from "./support/run-worker.ts";
import {
  REVISIT_INSTRUCTION,
  blockExit,
  finishedReport,
  handoffFlow,
  launchUncertain,
  replyTurnRunning,
  report,
  resultReleasedToSameWorker,
  resultReleasedToSecondWorker,
  resultReported,
  sentTurnBegins,
  workerAtWork,
  workerFinal,
  workingReport,
  workingReportedIdle,
} from "./support/scenarios.ts";

/** Entry worker's Agent has Done and Blocked; the Flow hides Blocked and adds a local Escalate. */
const exitVariant = {
  exits: [
    blockExit("done", "Done", "Completed"),
    blockExit("blocked", "Blocked", "Explain the blocker.", true),
  ],
  hiddenExitIds: ["blocked"],
  localExits: [blockExit("escalate", "Escalate", "", true)],
};

it("factory_get_block reads the Block named by the id in its launch message", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    state: "working",
    visit: 1,
    reason: "first",
    exits: [{ id: "done", name: "Done", description: "Completed", messageRequired: false }],
    inputs: {
      input: "Improve search\nKeep it accessible.",
      results: [],
      feedback: null,
    },
    allowedTransitions: ["working", "finished"],
  });
});

it("factory_get_block lists the Agent's visible exits, then the Flow's local exits, with description and message requirement", async (c) => {
  // Arrange
  const setup = await prepared(c, exitVariant);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result.exits).toStrictEqual([
    { id: "done", name: "Done", description: "Completed", messageRequired: false },
    { id: "escalate", name: "Escalate", description: "", messageRequired: true },
  ]);
});

it("a finished report on an exit hidden in the Run's Flow is refused with the Block's exits", async (c) => {
  // Arrange
  const setup = await prepared(c, exitVariant);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: {
      blockId: fixture.blockId,
      to: "finished",
      exit: "Blocked",
      message: "Waiting on credentials.",
    },
  });

  // Assert
  expect(result).toMatchObject({ code: "INVALID_EXIT", allowedExits: ["Done", "Escalate"] });
});

it("the launch message states the Block id and issues no tool ref", async (c) => {
  // Arrange
  const fixture = await prepared(c);
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
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

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
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

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
  const setup = await prepared(c);
  setup.t3.discoverAvailable = false;
  const fixture = { ...setup, ...(await launchUncertain(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.block({
    arguments: { blockId: launchedBlockId(fixture.t3) },
  });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", visit: 1, reason: "first" });
});

it("a worker resumed by the user's reply reads its Block and may report again", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const idle = await workingReportedIdle(setup.world, atWork);
  const fixture = { ...setup, ...(await replyTurnRunning(setup.world, idle)) };

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    visit: 1,
    allowedTransitions: ["working", "finished"],
  });
});

it("a downstream worker retrieves its incoming result and the Block that produced it", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  await resultReleasedToSecondWorker(setup.world, reported);
  const fixture = { ...setup, ...reported };

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
  const setup = await prepared(c, { revisit: true });
  const atWork = await workerAtWork(setup.world, setup.input);
  const fixture = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  expect([...fixture.t3.sends.values()][0]?.payload.message).toContain(
    `Factory Block id: ${fixture.blockId}.`,
  );
});

it("a feedback revisit carries the Revisit instruction under its conflict rule, then the incoming result", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const atWork = await workerAtWork(setup.world, setup.input);
  const fixture = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  expect([...fixture.t3.sends.values()][0]?.payload.message).toMatch(
    workerMessage(
      "Revisit instruction for this later visit of your Block. It decides the scope of this visit; your Agent's role, criteria, exits and reporting rules still apply. A narrower scope never permits skipping a required check or accepting a defect that has evidence; if you cannot reconcile the two, say so in your report. Your Block's previous finished result is available from factory_get_run.\n" +
        "Verify the fixes and the newly affected scope.\n\n" +
        "Incoming message:\n" +
        "Implemented the requested result.",
    ),
  );
});

it("a revisit with a Revisit instruction shows an empty incoming result as (no message)", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const atWork = await workerAtWork(setup.world, setup.input);
  const fixture = { ...setup, ...(await resultReported(setup.world, atWork, { message: "" })) };

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  expect([...fixture.t3.sends.values()][0]?.payload.message).toMatch(
    /\nVerify the fixes and the newly affected scope\.\n\nIncoming message:\n\(no message\)$/,
  );
});

it("a revisit without a Revisit instruction is the incoming result alone, as before", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true });
  const atWork = await workerAtWork(setup.world, setup.input);
  const fixture = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  expect([...fixture.t3.sends.values()][0]?.payload.message).toMatch(
    workerMessage("Implemented the requested result."),
  );
});

it("the first visit carries the Agent prompt without the Revisit instruction", async (c) => {
  // Arrange
  const fixture = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  assert((await fixture.f.startRun(fixture.input)).ok);

  // Act
  assert((await fixture.f.reconcileRuns()).ok);

  // Assert
  expect([...fixture.t3.launches.values()][0]?.payload.message).toMatch(
    workerMessage("Follow repository instructions."),
  );
});

it("a later visit's Block read returns the Revisit instruction with its conflict rule", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const fixture = { ...setup, ...(await resultReleasedToSameWorker(setup.world, reported)) };

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    visit: 2,
    revisitInstruction: "Verify the fixes and the newly affected scope.",
    revisitRule:
      "It decides the scope of this visit; your Agent's role, criteria, exits and reporting rules still apply. A narrower scope never permits skipping a required check or accepting a defect that has evidence; if you cannot reconcile the two, say so in your report.",
  });
});

it("a first visit's Block read omits the Revisit instruction", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.block({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", visit: 1 });
  expect(result).not.toHaveProperty("revisitInstruction");
  expect(result).not.toHaveProperty("revisitRule");
});

it("the Run read still returns a Block's previous finished result while its later visit is working", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork, { message: "Found two defects." });
  const released = await resultReleasedToSameWorker(setup.world, reported);
  const worker = sentTurnBegins(setup.world, released);
  const fixture = { ...setup, ...worker };
  assert(
    (await report(fixture.world, worker, workingReport("Checking the fixes."))) === "ACCEPTED",
  );

  // Act
  const result = await fixture.f.runtime.run({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "RUN",
    blocks: [{ blockId: "worker", state: "working", result: "Found two defects." }],
  });
});

it("a revisit's report applies to the Block's current activation", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const released = await resultReleasedToSameWorker(setup.world, reported);
  const worker = sentTurnBegins(setup.world, released);
  const fixture = { ...setup, ...worker };

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
  const setup = await prepared(c, { revisit: true });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const released = await resultReleasedToSameWorker(setup.world, reported);
  const worker = sentTurnBegins(setup.world, released);
  const fixture = { ...setup, ...worker };
  assert((await report(fixture.world, worker, finishedReport())) === "ACCEPTED");
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
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.run({ arguments: { blockId: fixture.blockId } });

  // Assert
  expect(result).toMatchObject({
    code: "RUN",
    number: 1,
    title: "Improve search",
    input: "Improve search\nKeep it accessible.",
    state: "active",
    blocks: [{ blockId: "worker", name: "Entry worker", state: "working", result: null }],
  });
});

it("a worker reports its result by naming its Block id", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.submit(workerFinal(fixture.blockId));

  // Assert
  expect(result).toMatchObject({
    code: "ACCEPTED",
    state: "working",
    allowedTransitions: ["working", "finished"],
    next: expect.stringContaining("A later finished report replaces it"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.reports).toMatchObject([
    { blockId: "worker", status: "finished", exitId: "done" },
  ]);
});

it("an identical repeated final succeeds again without a second result", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };
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

it("a retired waiting report is refused with guidance and leaves the Block's working report current", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const worker = await workerAtWork(setup.world, setup.input);
  const fixture = { ...setup, ...worker };
  assert((await report(fixture.world, worker, workingReport())) === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "waiting", message: "Which audience?" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "WAITING_RETIRED",
    reason: expect.stringContaining("questions to the user need no report"),
    next: expect.stringContaining("final chat message"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    reportStatus: "working",
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
  expect(run.value.attention).toStrictEqual([]);
});

it("a working Block update is accepted with its message and selects no result", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

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
    allowedTransitions: ["working", "finished"],
    next: expect.stringContaining("no missing-report Problem"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    reportStatus: "working",
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
  expect(run.value.executions).toMatchObject([
    { executionId: "execution-1", reportStatus: "working" },
  ]);
  expect(run.value.reports).toStrictEqual([]);
});

it("a later finished report replaces the Block's working report", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const worker = await workerAtWork(setup.world, setup.input);
  const fixture = { ...setup, ...worker };
  assert((await report(fixture.world, worker, workingReport())) === "ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit(workerFinal(fixture.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ reportStatus: "finished", workingMessage: null });
  expect(run.value.reports).toMatchObject([{ status: "finished", exitId: "done" }]);
});

it("a working report without a message is refused with repair guidance", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "working", message: "  " },
  });

  // Assert
  expect(result).toMatchObject({
    code: "MESSAGE_REQUIRED",
    reason: expect.stringContaining("needs a message"),
    next: expect.stringContaining("what you are doing or waiting on"),
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ reportStatus: null, workingMessage: null });
});

it("a working report that selects an exit is refused with repair guidance", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

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
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

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

it("a finished report without a message is accepted when that exit does not require a message", async (c) => {
  // Arrange
  const setup = await prepared(c);
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "finished", exit: "Done" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
});

it("a finished report without a message is refused when that exit requires a message", async (c) => {
  // Arrange
  const setup = await prepared(c, { exits: [blockExit("done", "Done", "Completed", true)] });
  const fixture = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { blockId: fixture.blockId, to: "finished", exit: "Done" },
  });

  // Assert
  expect(result).toMatchObject({ code: "FEEDBACK_REQUIRED" });
});

import { assert, expect, it } from "@effect/vitest";
import { launchedBlockId, workerMessage } from "./support/run-worker.ts";
import {
  REVISIT_INSTRUCTION,
  allTurnsEnd,
  correctionReviewFlow,
  executionFailed,
  followUpReplyRunning,
  handoffFlow,
  humanReviewFlow,
  missingReport,
  nextSend,
  replyTurnRunning,
  replyTurnObserved,
  workingReported,
  reportRecoveryCompleted,
  reportRecoveryLeftUnfinished,
  reportRecoveryRequested,
  resultHeld,
  resultReleasedToHumanReview,
  resultReleasedToSameWorker,
  resultReported,
  sentTurnBegins,
  turnBegins,
  workerAtWork,
  workerFinal,
  workerWorking,
  workingReportedIdle,
} from "./support/scenarios.ts";
import { answerDelegatedWait } from "./support/controlled-thread.ts";
import { prepared } from "./support/prepared-runner.ts";

it("a Flow with two entry Agents launches an independent top-level worker for each", async (c) => {
  // Arrange
  const f = await prepared(c);
  const editor = await f.f.createAgent({
    name: "Editor",
    prompt: "Edit the draft.",
    execution: { ...f.agent.execution, modelOptions: [{ id: "reasoning", value: "low" }] },
    exits: f.agent.exits,
  });
  assert(editor.ok);
  const review = f.flow.graph.blocks[0]!;
  const updated = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    workspace: f.flow.workspace,
    graph: {
      flowInput: { position: { x: 0, y: 0 }, targetBlockIds: ["worker", "editor"] },
      blocks: [
        { ...review, name: "Review" },
        {
          id: "editor",
          name: "Draft",
          kind: "agent",
          agentId: editor.value.id,
          position: { x: 240, y: 0 },
          hiddenExitIds: [],
          localExits: [],
        },
      ],
      connections: [],
    },
  });
  assert(updated.ok);
  const started = await f.f.startRun(f.input);
  assert(started.ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const result = await f.f.getRun(started.value.id);
  assert(result.ok);
  expect(result.value.number).toBe(1);
  expect(result.value.runCoordinator).toBeNull();
  expect(f.t3.launches.size).toBe(2);
  const launches = [...f.t3.launches.values()].map((launch) => launch.payload);
  expect(launches.map((launch) => launch.title)).toStrictEqual([
    "Factory #1 · 1 Review",
    "Factory #1 · 2 Draft",
  ]);
  expect(launches[0]!.message).toMatch(workerMessage("Follow repository instructions."));
  expect(launches[1]!.message).toMatch(workerMessage("Edit the draft."));
  expect(launches[0]!.modelSelection).toEqual({
    instanceId: "codex-main",
    model: "gpt-6.1-sol",
    options: { reasoning: "high" },
  });
  expect(launches[1]!.modelSelection).toEqual({
    instanceId: "codex-main",
    model: "gpt-6.1-sol",
    options: { reasoning: "low" },
  });
  expect(launches.every((launch) => launch.workspaceStrategy.type === "root")).toBe(true);
  expect(launches.every((launch) => launch.interactionMode === "default")).toBe(true);
  expect(result.value.blocks.map((block) => block.threadId)).toStrictEqual([
    "thread-1",
    "thread-2",
  ]);
});

it("two Blocks that share one Agent still launch separate workers", async (c) => {
  // Arrange
  const f = await prepared(c);
  const review = f.flow.graph.blocks[0]!;
  const updated = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    workspace: f.flow.workspace,
    graph: {
      flowInput: { position: { x: 0, y: 0 }, targetBlockIds: ["worker", "second"] },
      blocks: [
        { ...review, name: "Review" },
        { ...review, id: "second", name: "Second review", position: { x: 240, y: 0 } },
      ],
      connections: [],
    },
  });
  assert(updated.ok);
  const started = await f.f.startRun(f.input);
  assert(started.ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const result = await f.f.getRun(started.value.id);
  assert(result.ok);
  const launches = [...f.t3.launches.values()].map((launch) => launch.payload);
  expect(launches.map((launch) => launch.title)).toStrictEqual([
    "Factory #1 · 1 Review",
    "Factory #1 · 2 Second review",
  ]);
  expect(launches[0]!.message).toMatch(workerMessage("Follow repository instructions."));
  expect(launches[1]!.message).toMatch(workerMessage("Follow repository instructions."));
  expect(launchedBlockId(f.t3, "Review")).not.toBe(launchedBlockId(f.t3, "Second review"));
  expect(launches[0]!.clientRequestId).not.toBe(launches[1]!.clientRequestId);
  expect(result.value.blocks.map((block) => block.threadId)).toStrictEqual([
    "thread-1",
    "thread-2",
  ]);
});

it("normal Start launches the entry worker with its own Agent settings and no Run conversation", async (c) => {
  // Arrange
  const f = await prepared(c, handoffFlow);

  const started = await f.f.startRun(f.input);
  assert(started.ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const result = await f.f.getRun(started.value.id);
  assert(result.ok);
  expect(result.value.runCoordinator).toBeNull();
  expect(result.value.number).toBe(1);
  expect(f.t3.launches.size).toBe(1);
  const payload = [...f.t3.launches.values()][0]!.payload;
  expect(payload.title).toBe("Factory #1 · 1 Entry worker");
  expect(payload.message).toMatch(workerMessage("Follow repository instructions."));
  expect(payload.modelSelection.model).toBe(f.agent.execution.modelId);
  expect(payload.modelSelection.instanceId).toBe(f.agent.execution.providerInstanceId);
});
it("a completed reporting worker releases downstream work without a Run conversation", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };

  // Act
  const result = await f.f.reconcileRuns();

  // Assert
  assert(result.ok);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).not.toBeNull();
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker", "parallel-block"]);
});
it("a worker that fails after reporting cannot release downstream work", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork, { status: "failed" })) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(f.t3.sends.size).toBe(0);
});
it("an accepted result stays held while T3 has not settled the worker's delegated work", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  answerDelegatedWait(f.t3, "thread-1", "execution-1", "pending", "running");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(run.value.blocks[0]?.state).toBe("working");
  expect(f.t3.launches.size).toBe(1);
});

it("a worker rolled back after reporting shows a Problem and holds its prior result", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork, { status: "rolled_back" })) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ state: "error", problem: "execution-failed" });
  expect(run.value.attention.find((a) => a.kind === "execution-failed")).toMatchObject({
    executionId: "execution-1",
    settledAt: null,
  });
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(f.t3.sends.size).toBe(0);
  expect(run.value.lifecycle).toBe("active");
});
it("an accepted result stays held while the worker thread has a pending native request", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  const thread = f.t3.executionObservations.get("thread-1")!;
  f.t3.executionObservations.set("thread-1", { ...thread, pendingRequestCount: 1 });

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(f.t3.launches.size).toBe(1);
});
it("an accepted result stays held while the worker thread still has an active run", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultHeld(setup.world, atWork)) };
  answerDelegatedWait(f.t3, "thread-1", "execution-1", "settled", "completed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(f.t3.launches.size).toBe(1);
});
it("a worker waiting on unsettled background work stays working without a missing-report Problem", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  allTurnsEnd(f.world, worker);
  answerDelegatedWait(f.t3, "thread-1", "execution-1", "pending", "completed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ state: "working", problem: null });
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});
it("a worker idle after reporting working shows its message without a missing-report Problem", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  await workingReported(f.world, worker);
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    engineStatus: "completed",
    problem: null,
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});
it("a reportless turn resumed by a notification shows a missing report once T3 settles the thread", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  allTurnsEnd(f.world, worker);
  answerDelegatedWait(f.t3, "thread-1", "execution-1", "pending", "completed");
  assert((await f.f.reconcileRuns()).ok);
  turnBegins(f.world, worker, "notification-execution");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ state: "error", problem: "missing-report" });
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toMatchObject([{ executionId: "notification-execution" }]);
});
it("a failed worker run shows an execution-failed Problem that settles when a later run of the thread completes", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await executionFailed(setup.world, atWork);
  const f = { ...setup, ...worker };
  turnBegins(f.world, worker, "retry-execution");
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => a.kind === "execution-failed")).toMatchObject({
    executionId: "execution-1",
    settledAt: expect.any(String),
    settlementReason: "completed",
  });
});
it("a failed worker run's Problem settles when the Block reports", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  allTurnsEnd(f.world, worker, "interrupted");
  assert((await f.f.reconcileRuns()).ok);

  // Act
  const result = await f.f.runtime.submit(workerWorking(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => a.kind === "execution-failed")).toMatchObject({
    settledAt: expect.any(String),
    settlementReason: "report-accepted",
  });
  expect(run.value.blocks[0]).toMatchObject({ state: "working", problem: null });
});
it("an execution failure settled by a report is not raised again while that run is still the thread's latest", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await executionFailed(setup.world, atWork);
  const f = { ...setup, ...worker };
  await workingReported(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.filter((a) => a.kind === "execution-failed")).toMatchObject([
    { executionId: "execution-1", settlementReason: "report-accepted" },
  ]);
  expect(run.value.blocks[0]).toMatchObject({ state: "working", problem: null });
});
it("a new failed run after a settled execution failure shows a new Problem", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const worker = await executionFailed(setup.world, atWork);
  const f = { ...setup, ...worker };
  await workingReported(f.world, worker);
  turnBegins(f.world, worker, "retry-execution");
  allTurnsEnd(f.world, worker, "failed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(
    run.value.attention.filter((a) => a.kind === "execution-failed" && !a.settledAt),
  ).toMatchObject([{ executionId: "retry-execution" }]);
  expect(run.value.blocks[0]).toMatchObject({ state: "error", problem: "execution-failed" });
});
it("repeating the current working report after a failed run settles the execution failure", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const worker = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...worker };
  await workingReported(f.world, worker);
  allTurnsEnd(f.world, worker, "failed");
  assert((await f.f.reconcileRuns()).ok);

  // Act
  const result = await f.f.runtime.submit(workerWorking(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => a.kind === "execution-failed")).toMatchObject({
    settledAt: expect.any(String),
    settlementReason: "report-accepted",
  });
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    problem: null,
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
});
it("missing-report recovery targets the original worker and retains its activation", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await missingReport(setup.world, atWork)) };

  // Act
  const result = await f.f.requestReport(f.runId, { blockId: f.missing.blockId });

  // Assert
  assert(result.ok, JSON.stringify(result));
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-1");
  expect([...f.t3.sends.values()][0]?.payload.message).toContain(`Factory Block id: ${f.blockId}.`);
  expect(
    result.value.executions.find(
      (e) => e.executionId === [...f.t3.sends.values()][0]?.reference.runId,
    )?.activationId,
  ).toBe(result.value.activations[0]?.id);
  expect(f.t3.launches.size).toBe(1);
});
it("Request report on a worker idle in working queues an assessment turn on its thread", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await workingReportedIdle(setup.world, atWork)) };

  // Act
  const result = await f.f.requestReport(f.runId, { blockId: "worker" });

  // Assert
  assert(result.ok, JSON.stringify(result));
  const sent = [...f.t3.sends.values()];
  expect(sent).toHaveLength(1);
  expect(sent[0]?.payload.threadId).toBe("thread-1");
  expect(sent[0]?.payload.message).toContain(`Factory Block id: ${f.blockId}.`);
  expect(sent[0]?.payload.message).toContain(
    "Factory Request report: assess the existing work without repeating the task.",
  );
  expect(result.value.recoveries).toMatchObject([
    { blockId: "worker", attentionId: null, sourceExecutionId: "execution-1" },
  ]);
  expect(f.t3.launches.size).toBe(1);
});
it("Request report on a later visit asks for an assessment without the Revisit instruction", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const released = await resultReleasedToSameWorker(setup.world, reported);
  const f = {
    ...setup,
    ...(await workingReportedIdle(setup.world, sentTurnBegins(setup.world, released))),
  };

  // Act
  const result = await f.f.requestReport(f.runId, { blockId: "worker" });

  // Assert
  assert(result.ok, JSON.stringify(result));
  const request = [...f.t3.sends.values()].at(-1)?.payload.message;
  expect(f.t3.sends.size).toBe(2);
  expect(request).toContain("Factory Request report: assess the existing work");
  expect(request).not.toContain("Revisit instruction");
  expect(request).not.toContain(REVISIT_INSTRUCTION);
});
it("a revisit reuses the direct worker with distinct activation ownership", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const f = { ...setup, ...(await resultReleasedToSameWorker(setup.world, reported)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(2);
  expect(run.value.threadBindings.map((b) => b.threadId)).toStrictEqual(["thread-1"]);
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-1");
  expect(
    run.value.executions.find((e) => e.executionId === [...f.t3.sends.values()][0]?.reference.runId)
      ?.activationId,
  ).toBe(run.value.activations[1]?.id);
  expect(f.t3.launches.size).toBe(1);
});
it("a prepared revisit is not sent while its worker thread has started another run", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  setup.t3.sendSupported = false;
  const worker = await resultReleasedToSameWorker(setup.world, reported);
  setup.t3.sendSupported = true;
  const f = { ...setup, ...worker };
  turnBegins(f.world, worker, "reply-execution");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.intents.find((intent) => intent.kind === "send")?.state).toBe("pending");
  expect(f.t3.sends.size).toBe(0);
});
it("restart preserves the worker binding without replaying accepted work", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const f = { ...setup, ...(await workerAtWork(setup.world, setup.input)) };
  await f.f.close();

  // Act
  const reopened = await f.h.open({ t3: f.t3 });

  // Assert
  const run = await reopened.getRun(f.runId);
  assert(run.ok);
  expect(run.value.threadBindings.map((b) => b.role)).toStrictEqual(["worker"]);
  expect(run.value.executions[0]?.activationId).toBe(run.value.activations[0]?.id);
  expect(f.t3.launches.size).toBe(1);
  expect(f.t3.sends.size).toBe(0);
});
it("after a lost acknowledgement and a restart, recovery resends the identical revisit with its Revisit instruction", async (c) => {
  // Arrange
  const setup = await prepared(c, { revisit: true, revisitInstruction: REVISIT_INSTRUCTION });
  const atWork = await workerAtWork(setup.world, setup.input);
  const reported = await resultReported(setup.world, atWork);
  const attempts: unknown[] = [];
  setup.t3.beforeSend = async (payload) => void attempts.push(payload);
  setup.t3.loseSendReply = true;
  const f = { ...setup, ...(await resultReleasedToSameWorker(setup.world, reported)) };
  await f.f.close();
  f.t3.loseSendReply = false;
  const reopened = await f.h.open({ t3: f.t3 });
  c.onTestFinished(() => reopened.close());

  // Act
  const reconciled = await reopened.reconcileRuns();

  // Assert
  assert(reconciled.ok);
  const run = await reopened.getRun(f.runId);
  assert(run.ok);
  expect(run.value.intents.filter((intent) => intent.kind === "send")).toMatchObject([
    { state: "acknowledged" },
  ]);
  expect(attempts.length).toBeGreaterThan(1);
  expect(attempts.at(-1)).toStrictEqual(attempts[0]);
  expect([...f.t3.sends.values()].map((send) => send.payload.message)).toStrictEqual([
    expect.stringContaining(`\n${REVISIT_INSTRUCTION}\n\nIncoming message:\n`),
  ]);
});
it("a worker resumed by the user's reply finishes the same activation without another working report", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const idle = await workingReportedIdle(setup.world, atWork);
  const f = { ...setup, ...(await replyTurnRunning(setup.world, idle)) };

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(1);
  expect(run.value.reports).toMatchObject([
    { status: "finished", activationId: run.value.activations[0]?.id },
  ]);
});
it("a later user reply can finish the activation after a reportless reply and backend restart", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const idle = await workingReportedIdle(setup.world, atWork);
  const replying = await replyTurnRunning(setup.world, idle);
  const f = { ...setup, ...(await followUpReplyRunning(setup.world, replying)) };
  await f.f.close();
  const factory = await f.h.open({ t3: f.t3 });

  // Act
  const result = await factory.runtime.submit(workerFinal(f.blockId));

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await factory.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(1);
  expect(run.value.reports).toMatchObject([{ activationId: run.value.activations[0]?.id }]);
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
});
it("reply turns without reports keep the Block working with its message and no Problem or Needs input", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const idle = await workingReportedIdle(setup.world, atWork);
  const worker = await replyTurnObserved(setup.world, idle);
  const f = { ...setup, ...worker };
  allTurnsEnd(f.world, worker);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    engineStatus: "completed",
    problem: null,
    workingMessage: "Opened PR #42; waiting for its CI checks.",
  });
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
  expect(run.value.reports).toStrictEqual([]);
});

it("completed direct worker recovery settles the original missing report only after source release", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const missing = await missingReport(setup.world, atWork);
  const recovering = await reportRecoveryRequested(setup.world, missing);
  const f = { ...setup, ...(await reportRecoveryCompleted(setup.world, recovering)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.recoveries[0]?.settledAt).not.toBeNull();
  expect(run.value.recoveries[0]?.executionId).toBe(f.executionId);
  expect(run.value.reports[0]?.completionEligibleAt).not.toBeNull();
});

it("Request report on a worker idle in working settles once the assessment turn's result is released", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const idle = await workingReportedIdle(setup.world, atWork);
  const recovering = await reportRecoveryRequested(setup.world, idle);
  const f = { ...setup, ...(await reportRecoveryCompleted(setup.world, recovering)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.recoveries).toMatchObject([
    { attentionId: null, executionId: f.executionId, settledAt: expect.any(String) },
  ]);
});

it("a Request report turn that finds unfinished work keeps the Block working and its recovery open", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const missing = await missingReport(setup.world, atWork);
  const recovering = await reportRecoveryRequested(setup.world, missing);
  const f = { ...setup, ...(await reportRecoveryLeftUnfinished(setup.world, recovering)) };

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.recoveries).toMatchObject([{ executionId: f.executionId, settledAt: null }]);
  expect(run.value.reports).toStrictEqual([]);
  expect(run.value.blocks[0]).toMatchObject({ state: "working", problem: null });
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});

it("a Human answer releases its outgoing handoff without waiting for worker evidence", async (c) => {
  // Arrange
  const setup = await prepared(c, humanReviewFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const f = { ...setup, ...(await resultReleasedToHumanReview(setup.world, reported)) };

  // Act
  const result = await f.f.answerHumanOccurrence(f.occurrence.id, { exitId: "approve" });

  // Assert
  assert(result.ok);
  expect(result.value.humanOccurrences[0]?.state).toBe("answered");
  const handoff = result.value.intents.find((i) => i.occurrenceId === f.occurrence.id);
  expect(handoff).toMatchObject({ blockId: "parallel-block", sourceBlockId: "review" });
  expect(result.value.events).toContainEqual(
    expect.objectContaining({ kind: "handoff-created", causeId: handoff?.id }),
  );
});

it("a Human answer requesting changes revisits the worker with its Revisit instruction before the person's message", async (c) => {
  // Arrange
  const setup = await prepared(c, correctionReviewFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const f = { ...setup, ...(await resultReleasedToHumanReview(setup.world, reported)) };
  const revisitSent = nextSend(f.world);

  // Act
  const result = await f.f.answerHumanOccurrence(f.occurrence.id, {
    exitId: "request-changes",
    message: "Handle the empty query.",
  });

  // Assert
  assert(result.ok);
  const revisit = await revisitSent;
  expect(revisit.threadId).toBe(f.threadId);
  expect(revisit.message).toContain("\n\nRevisit instruction for this later visit of your Block. ");
  expect(revisit.message).toMatch(
    /\nVerify the fixes and the newly affected scope\.\n\nIncoming message:\nHandle the empty query\.$/,
  );
});
it("competing Human answers settle the occurrence once and the other answer is refused as a conflict", async (c) => {
  // Arrange
  const setup = await prepared(c, humanReviewFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const f = { ...setup, ...(await resultReleasedToHumanReview(setup.world, reported)) };

  // Act
  const results = await Promise.all([
    f.f.answerHumanOccurrence(f.occurrence.id, { exitId: "approve" }),
    f.f.answerHumanOccurrence(f.occurrence.id, {
      exitId: "request-changes",
      message: "Split the migration.",
    }),
  ]);

  // Assert
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toMatchObject([
    {
      error: {
        code: "conflict",
        message: "This occurrence has already been settled with a different answer or reason.",
      },
    },
  ]);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.humanOccurrences).toMatchObject([{ state: "answered" }]);
  expect(run.value.events.filter((event) => event.kind === "human-answered")).toHaveLength(1);
});

it("a Request changes answer without a message is rejected and the review stays pending", async (c) => {
  // Arrange
  const setup = await prepared(c, humanReviewFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const f = { ...setup, ...(await resultReleasedToHumanReview(setup.world, reported)) };

  // Act
  const result = await f.f.answerHumanOccurrence(f.occurrence.id, { exitId: "request-changes" });

  // Assert
  assert(!result.ok);
  expect(result.error).toMatchObject({
    code: "validation",
    message: "Request changes requires a message.",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.humanOccurrences).toMatchObject([{ state: "pending", exitId: null }]);
});

it("a Human answer naming an exit other than Approve or Request changes is rejected", async (c) => {
  // Arrange
  const setup = await prepared(c, humanReviewFlow);
  const reported = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const f = { ...setup, ...(await resultReleasedToHumanReview(setup.world, reported)) };

  // Act
  const result = await f.f.answerHumanOccurrence(f.occurrence.id, { exitId: "done" });

  // Assert
  assert(!result.ok);
  expect(result.error.message).toBe("Choose Approve or Request changes.");
});

it("a held worker handoff launches exactly one next worker after a backend restart", async (c) => {
  // Arrange
  const setup = await prepared(c, handoffFlow);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  await f.f.close();

  // Act
  const reopened = await f.h.open({ t3: f.t3 });

  // Assert
  const run = await reopened.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker", "parallel-block"]);
  expect(run.value.intents).toContainEqual(
    expect.objectContaining({
      blockId: "parallel-block",
      kind: "launch",
      state: "acknowledged",
    }),
  );
  expect(f.t3.launches.size).toBe(2);
});

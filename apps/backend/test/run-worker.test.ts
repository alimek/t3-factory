import { assert, expect, it } from "@effect/vitest";
import { workerWithUnavailableRun } from "./support/run-worker-isolation.ts";
import { completedWorkerRecovery } from "./support/run-worker-recovery.ts";
import {
  workerWithDroppedDescendant,
  workerWithLostDescendantEvidence,
} from "./support/run-worker-evidence.ts";
import {
  workerStart,
  directWorker,
  workerFinal,
  reportedWorker,
  waitingWorker,
  missingWorkerReport,
  revisitedWorker,
  workerNativeReply,
  workerFollowupReply,
  finishedWorker,
  pendingReview,
  interruptRunConversation,
} from "./support/run-worker.ts";
import { bindThreadReportCaller } from "./support/lifecycle-setup.ts";
import { prepared } from "./support/prepared-runner.ts";

it("a Flow with two entry Agents launches an independent top-level worker for each", async (c) => {
  // Arrange
  const f = await prepared(c);
  const editor = await f.f.createAgent({
    name: "Editor",
    prompt: "Edit the draft.",
    execution: { ...f.agent.execution, modelOptions: [{ id: "reasoning", value: "low" }] },
  });
  assert(editor.ok);
  const review = f.flow.graph.blocks[0]!;
  const updated = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
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
          exits: review.exits,
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
  expect(launches[0]!.message).toBe(
    `$factory-block\n\nFollow repository instructions.\n\nFactory tool ref: ${launches[0]!.clientRequestId}. Pass ref on every factory_get_block, factory_get_run, and factory_update_block call.`,
  );
  expect(launches[1]!.message).toBe(
    `$factory-block\n\nEdit the draft.\n\nFactory tool ref: ${launches[1]!.clientRequestId}. Pass ref on every factory_get_block, factory_get_run, and factory_update_block call.`,
  );
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
  expect(launches.map((launch) => launch.message)).toStrictEqual([
    `$factory-block\n\nFollow repository instructions.\n\nFactory tool ref: ${launches[0]!.clientRequestId}. Pass ref on every factory_get_block, factory_get_run, and factory_update_block call.`,
    `$factory-block\n\nFollow repository instructions.\n\nFactory tool ref: ${launches[1]!.clientRequestId}. Pass ref on every factory_get_block, factory_get_run, and factory_update_block call.`,
  ]);
  expect(launches[0]!.clientRequestId).not.toBe(launches[1]!.clientRequestId);
  expect(result.value.blocks.map((block) => block.threadId)).toStrictEqual([
    "thread-1",
    "thread-2",
  ]);
});

it("normal Start launches the entry worker with its own Agent settings and no Run conversation", async (c) => {
  // Arrange
  const f = await workerStart(c);

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
  expect(payload.message).toBe(
    `$factory-block\n\nFollow repository instructions.\n\nFactory tool ref: ${payload.clientRequestId}. Pass ref on every factory_get_block, factory_get_run, and factory_update_block call.`,
  );
  expect(payload.modelSelection.model).toBe(f.agent.execution.modelId);
  expect(payload.modelSelection.instanceId).toBe(f.agent.execution.providerInstanceId);
});
it("a completed reporting worker releases downstream work without a Run conversation", async (c) => {
  // Arrange
  const f = await reportedWorker(c);

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
  const f = await reportedWorker(c, "failed");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(f.t3.sends.size).toBe(0);
});
it("a worker on the project checkout can still report", async (c) => {
  // Arrange
  const f = await directWorker(c);
  f.t3.reportCheckoutWorkspace = true;

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
});

it("a foreign thread cannot report a worker final", async (c) => {
  // Arrange
  const f = await directWorker(c);
  bindThreadReportCaller(f.t3, f.project.projectId, "thread-9", "execution-9", "worker-report");

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).not.toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
});
it("a worker clarification is scoped to its exact worker execution", async (c) => {
  // Arrange
  const f = await directWorker(c);

  // Act
  const result = await f.f.runtime.submit({
    arguments: { to: "waiting", message: "Which audience?" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention.find((a) => a.kind === "conversation-waiting")?.bindingId).toBe(
    run.value.threadBindings[0]?.id,
  );
  expect(run.value.reports).toStrictEqual([]);
});

it("an explicit answer is delivered to the exact worker question", async (c) => {
  // Arrange
  const f = await waitingWorker(c);

  // Act
  const result = await f.f.replyCoordinatorQuestion(f.runId, {
    attentionId: f.question.id,
    requestId: "answer",
    message: "Public audience.",
  });

  // Assert
  assert(result.ok, JSON.stringify(result));
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-1");
  expect(
    result.value.executions.find(
      (e) => e.executionId === [...f.t3.sends.values()][0]?.reference.runId,
    )?.activationId,
  ).toBe(result.value.activations[0]?.id);
});
it("missing-report recovery targets the original worker and retains its activation", async (c) => {
  // Arrange
  const f = await missingWorkerReport(c);

  // Act
  const result = await f.f.requestReport(f.missing.id);

  // Assert
  assert(result.ok, JSON.stringify(result));
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-1");
  expect(
    result.value.executions.find(
      (e) => e.executionId === [...f.t3.sends.values()][0]?.reference.runId,
    )?.activationId,
  ).toBe(result.value.activations[0]?.id);
  expect(f.t3.launches.size).toBe(1);
});
it("a revisit reuses the direct worker with distinct activation ownership", async (c) => {
  // Arrange
  const f = await revisitedWorker(c);

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
it("restart preserves direct worker authority without replaying accepted work", async (c) => {
  // Arrange
  const f = await directWorker(c);
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
it("a descendant discovered by a failed assessment still holds a worker final after native history loss and restart", async (c) => {
  // Arrange
  const f = await workerWithLostDescendantEvidence(c);

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ASSESSMENT_UNVERIFIED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
  expect(run.value.threadBindings).toContainEqual(
    expect.objectContaining({ threadId: "thread-3", role: "descendant" }),
  );
});
it("Stop keeps a saved running descendant after it leaves the worker native activity", async (c) => {
  // Arrange
  const f = await workerWithDroppedDescendant(c);
  assert((await f.f.stopRun(f.runId)).ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.closedAt).toBeNull();
  expect(f.t3.treeStops.map((stop) => stop.threadId)).toContain("thread-3");
});

it("Stop interrupts a root-strategy worker whose thread has no worktree", async (c) => {
  // Arrange
  const f = await directWorker(c);
  f.t3.reportCheckoutWorkspace = true;
  assert((await f.f.stopRun(f.runId)).ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.closedAt).toBeNull();
  expect(f.t3.treeStops.map((stop) => stop.threadId)).toContain("thread-1");
});

it("Stop retains the primary and worker tree until native completion is confirmed", async (c) => {
  // Arrange
  const f = await directWorker(c);

  const stopped = await f.f.stopRun(f.runId);
  assert(stopped.ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const result = await f.f.getRun(f.runId);
  assert(result.ok);
  expect(result.value.gateOpen).toBe(false);
  expect(result.value.closedAt).toBeNull();
  expect(f.t3.treeStops.map((s) => s.threadId)).toContain("thread-1");
  expect(f.t3.launches.size).toBe(1);
});
it("a native user answer with omitted sender binds its exact continuation and settles the question before accepting its final", async (c) => {
  // Arrange
  const f = await workerNativeReply(c);

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.executionId).toBe("answer-execution");
  expect(run.value.reports[0]?.activationId).toBe(run.value.activations[0]?.id);
  expect(run.value.executions.find((e) => e.executionId === "answer-execution")?.activationId).toBe(
    run.value.activations[0]?.id,
  );
  expect(run.value.attention.find((a) => a.id === f.question.id)).toMatchObject({
    settledAt: expect.any(String),
    settlementReason: "completed",
  });
});
it("a native user answer with explicit null sender retains worker report authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, { senderThreadId: null });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
});
it("a later native user reply can finish the activation after a reportless reply and backend restart", async (c) => {
  // Arrange
  const f = await workerFollowupReply(c);
  await f.f.close();
  const factory = await f.h.open({ t3: f.t3 });

  // Act
  const result = await factory.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await factory.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(1);
  expect(run.value.reports).toMatchObject([
    { executionId: "followup-execution", activationId: run.value.activations[0]?.id },
  ]);
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
});
it("a later native user reply can ask another question after a reportless reply", async (c) => {
  // Arrange
  const f = await workerFollowupReply(c);

  // Act
  const result = await f.f.runtime.submit({
    arguments: { to: "waiting", message: "Confirm the revised scope?" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(1);
  expect(run.value.reports).toStrictEqual([]);
  expect(
    run.value.attention.filter((a) => a.kind === "conversation-waiting" && !a.settledAt),
  ).toMatchObject([{ executionId: "followup-execution", message: "Confirm the revised scope?" }]);
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
});
it("an agent-authored follow-up cannot acquire report authority from a settled worker question", async (c) => {
  // Arrange
  const f = await workerFollowupReply(c, { createdBy: "agent" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
});
it("a native user answer with omitted sender can ask a new question on the same activation", async (c) => {
  // Arrange
  const f = await workerNativeReply(c);

  // Act
  const result = await f.f.runtime.submit({
    arguments: { to: "waiting", message: "Which tone?" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.executions.find((e) => e.executionId === "answer-execution")?.activationId).toBe(
    run.value.activations[0]?.id,
  );
  expect(run.value.attention.find((a) => a.id === f.question.id)?.settledAt).toEqual(
    expect.any(String),
  );
  expect(
    run.value.attention.filter((a) => a.kind === "conversation-waiting" && !a.settledAt),
  ).toMatchObject([{ executionId: "answer-execution", message: "Which tone?" }]);
  expect(run.value.reports).toStrictEqual([]);
});
it("an agent-authored follow-up cannot acquire worker question authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, { createdBy: "agent" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});
it("a follow-up without actor provenance cannot acquire worker question authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c);
  const { createdBy: _actor, ...reply } = f.t3.runtimeActivity.items.at(-1)!;
  f.t3.runtimeActivity = {
    ...f.t3.runtimeActivity,
    items: [f.t3.runtimeActivity.items[0]!, reply],
  };

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});
it("a user-authored message forwarded from another thread cannot acquire worker question authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, { senderThreadId: "thread-9" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});
it("a user-authored message sourced from another thread cannot acquire worker question authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, { sourceThreadId: "foreign-thread" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});
it("an inherited user message cannot acquire worker question authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, { visibility: "inherited" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});
it("a native user answer for a different execution cannot authorize the reporting execution", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, { runId: "other-execution" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});
it("an accepted worker final cannot be replaced by a different final", async (c) => {
  // Arrange
  const f = await directWorker(c);
  expect((await f.f.runtime.submit(workerFinal())).code).toBe("ACCEPTED");

  // Act
  const result = await f.f.runtime.submit({
    ...workerFinal(),
    arguments: { ...workerFinal().arguments, message: "Changed result" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "FINAL_CONFLICT",
    state: "working",
    allowedTransitions: [],
    allowedExits: ["Done"],
  });
});

it("a known worker report never reads an unrelated unavailable Run", async (c) => {
  // Arrange
  const f = await workerWithUnavailableRun(c);

  // Act
  const result = await f.f.runtime.submit({ ...workerFinal(), inheritedThreadId: "thread-1" });

  // Assert
  expect(result.code).toBe("ACCEPTED");
  expect(f.unrelatedReads()).toBe(0);
});

it("completed direct worker recovery settles the original missing report only after source release", async (c) => {
  // Arrange
  const f = await completedWorkerRecovery(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.recoveries[0]?.settledAt).not.toBeNull();
  expect(run.value.recoveries[0]?.executionId).toBe(f.executionId);
  expect(run.value.reports[0]?.completionEligibleAt).not.toBeNull();
});

it("a reported worker closes the Run as finished once its worker tree is freshly quiet", async (c) => {
  // Arrange
  const f = await finishedWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBe("finished");
  expect(run.value.closure?.rootFrontier ?? []).toStrictEqual([]);
  expect(run.value.closure?.frontier.map((member) => member.threadId)).toContain("thread-1");
  const tasks = await f.f.listTasks(f.project.id);
  assert(tasks.ok);
  expect(tasks.value[0]?.activeRunId).toBeNull();
});

it("a completed worker keeps its Task active while worker settlement is unknown", async (c) => {
  // Arrange
  const f = await finishedWorker(c);
  f.t3.delegatedSettlements.delete(JSON.stringify(["thread-1", "execution-1"]));

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBeNull();
  expect(run.value.closedAt).toBeNull();
  const tasks = await f.f.listTasks(f.project.id);
  assert(tasks.ok);
  expect(tasks.value[0]?.activeRunId).toBe(f.runId);
});

it("Stop cancels undispatched handoffs and settles the Run as stopped once its tree is terminal", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  assert((await f.f.stopRun(f.runId)).ok);
  interruptRunConversation(f.t3);
  assert((await f.f.reconcileRuns()).ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBe("stopped");
  expect(run.value.intents).toContainEqual(
    expect.objectContaining({ blockId: "parallel-block", state: "cancelled" }),
  );
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker"]);
  expect(f.t3.sends.size).toBe(0);
});

it("a Human answer releases its outgoing handoff without waiting for worker evidence", async (c) => {
  // Arrange
  const f = await pendingReview(c);

  // Act
  const result = await f.f.answerHumanOccurrence(f.occurrence.id, { exitId: "done" });

  // Assert
  assert(result.ok);
  expect(result.value.humanOccurrences[0]?.state).toBe("answered");
  const handoff = result.value.intents.find((i) => i.occurrenceId === f.occurrence.id);
  expect(handoff).toMatchObject({ blockId: "parallel-block", sourceBlockId: "review" });
  expect(result.value.events).toContainEqual(
    expect.objectContaining({ kind: "handoff-created", causeId: handoff?.id }),
  );
});

it("a held worker handoff launches exactly one next worker after a backend restart", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
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

it("a subagent tool item cannot authorize its worker's final result", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const activity = f.t3.runtimeActivity;
  f.t3.runtimeActivity = {
    ...activity,
    items: activity.items.map((item) => ({ ...item, subagentId: "subagent" })),
  };

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("FOREIGN_CALLER");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
});

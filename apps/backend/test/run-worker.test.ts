import { assert, expect, it } from "@effect/vitest";
import { workerWithUnavailableRun } from "./support/run-worker-isolation.ts";
import { completedWorkerRecovery } from "./support/run-worker-recovery.ts";
import { workerWithLostDescendantEvidence } from "./support/run-worker-evidence.ts";
import {
  workerStart,
  directWorker,
  workerFinal,
  reportedWorker,
  waitingWorker,
  missingWorkerReport,
  revisitedWorker,
  workerNativeReply,
  finishedWorker,
  pendingReview,
  interruptRunConversation,
} from "./support/run-worker.ts";
import { bindThreadReportCaller } from "./support/lifecycle-setup.ts";

it("normal Start requires no Agent coordinator and launches only the primary conversation with a direct worker plan", async (c) => {
  // Arrange
  const f = await workerStart(c);

  const started = await f.f.startRun(f.input);
  assert(started.ok);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const result = await f.f.getRun(started.value.id);
  assert(result.ok);
  expect(result.value.snapshot.executionContract).toBe("run-worker-v1");
  expect(result.value.snapshot.coordinationInstructionVersion).toBe(5);
  expect(f.t3.launches.size).toBe(1);
  const plan = JSON.parse([...f.t3.launches.values()][0]!.payload.message.split("\n").at(-1)!);
  expect(plan.target.model).toBe(f.agent.execution.modelId);
  expect(plan.task).toContain("direct worker");
  expect(plan.task).not.toContain("assess your worker");
});
it("a completed reporting worker releases downstream work independently of the active primary conversation", async (c) => {
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
it("the primary conversation cannot report a worker final", async (c) => {
  // Arrange
  const f = await directWorker(c);
  bindThreadReportCaller(f.t3, f.project.projectId, "thread-1", "execution-1", "worker-report");

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
    arguments: { key: "question", status: "waiting", message: "Which audience?" },
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

it("an explicit answer is delivered to the exact worker question without involving the primary conversation", async (c) => {
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
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-2");
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
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-2");
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
  expect(run.value.threadBindings.map((b) => b.threadId)).toStrictEqual(["thread-2"]);
  expect([...f.t3.sends.values()][0]?.payload.threadId).toBe("thread-2");
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
it("a verified native user answer grants only its exact worker continuation report authority", async (c) => {
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
});
it("an agent-authored follow-up cannot acquire worker question authority", async (c) => {
  // Arrange
  const f = await workerNativeReply(c, "agent");

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
    arguments: { ...workerFinal().arguments, key: "replacement", message: "Changed result" },
  });

  // Assert
  expect(result.code).toBe("FINAL_CONFLICT");
});

it("a known worker report never reads an unrelated unavailable Run", async (c) => {
  // Arrange
  const f = await workerWithUnavailableRun(c);

  // Act
  const result = await f.f.runtime.submit({ ...workerFinal(), inheritedThreadId: "thread-2" });

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

it("a reported worker closes the Run as finished once the Run conversation and worker tree are freshly quiet", async (c) => {
  // Arrange
  const f = await finishedWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBe("finished");
  expect(run.value.closure?.rootFrontier?.map((member) => member.threadId)).toContain("thread-1");
  expect(run.value.closure?.frontier.map((member) => member.threadId)).toContain("thread-2");
  const tasks = await f.f.listTasks(f.project.id);
  assert(tasks.ok);
  expect(tasks.value[0]?.activeRunId).toBeNull();
});

it("a completed worker keeps its Task active while Run conversation settlement is unknown", async (c) => {
  // Arrange
  const f = await finishedWorker(c);
  f.t3.delegatedSettlements.delete(JSON.stringify(["thread-1", "execution-1"]));

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBeNull();
  expect(run.value.runCoordinator?.problem).toContain("coverage remains unresolved");
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
  expect(run.value.intents).toMatchObject([{ blockId: "parallel-block", state: "cancelled" }]);
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

it("a held worker handoff becomes exactly one next-worker command after a backend restart", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  await f.f.close();

  // Act
  const reopened = await f.h.open({ t3: f.t3 });

  // Assert
  const run = await reopened.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker", "parallel-block"]);
  expect(run.value.intents).toMatchObject([{ blockId: "parallel-block", kind: "launch" }]);
  expect(f.t3.launches.size).toBe(1);
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

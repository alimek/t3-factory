import { assert, expect, it } from "@effect/vitest";
import { capturedDefinitions, releasedUpgradeData } from "./support/released-upgrade.ts";
import { bindThreadReportCaller } from "./support/lifecycle-setup.ts";
import { workerFinal } from "./support/run-worker.ts";

it("upgrading v0.2.0 preserves clients, current definitions and closed and active Run history", async (c) => {
  // Arrange
  const fixture = await releasedUpgradeData(c);

  // Act
  const factory = await fixture.h.open({ t3: fixture.t3, connectionRetryMs: 60_000 });

  // Assert
  expect(await factory.listClients()).toStrictEqual({ ok: true, value: fixture.clients });
  const approved = await factory.getClientAccess(fixture.approvedCredential);
  assert(approved.ok);
  expect(approved.value.status).toBe("approved");
  const revoked = await factory.getClientAccess(fixture.revokedCredential);
  assert(revoked.ok);
  expect(revoked.value.status).toBe("revoked");
  expect(await factory.listFlows()).toMatchObject({ ok: true, value: [{ id: fixture.flow.id }] });
  expect(await factory.getFlow(fixture.flow.id)).toStrictEqual({ ok: true, value: fixture.flow });
  expect(await factory.listAgents()).toMatchObject({ ok: true, value: [{ id: fixture.agent.id }] });
  expect(await factory.getAgent(fixture.agent.id)).toStrictEqual({
    ok: true,
    value: fixture.agent,
  });
  const retiredFlow = await factory.getFlow(fixture.retired.flow.id);
  assert(!retiredFlow.ok);
  expect(retiredFlow.error.code).toBe("not_found");
  const retiredAgent = await factory.getAgent(fixture.retired.agent.id);
  assert(!retiredAgent.ok);
  expect(retiredAgent.error.code).toBe("not_found");
  const { snapshot: closedSnapshot, ...closed } = fixture.closed;
  expect(await factory.getRun(fixture.closed.id)).toStrictEqual({
    ok: true,
    value: { ...closed, definitions: capturedDefinitions(closedSnapshot) },
  });
  const active = await factory.getRun(fixture.active.id);
  assert(active.ok);
  expect(active.value).toMatchObject({
    id: fixture.active.id,
    closedAt: null,
    outcome: null,
    threadBindings: fixture.active.threadBindings,
  });
  expect(active.value.definitions).toStrictEqual(capturedDefinitions(fixture.active.snapshot));
  const [activation] = fixture.active.activations;
  const [execution] = fixture.active.executions;
  assert(activation && execution);
  expect(active.value.activations).toMatchObject([
    { id: activation.id, blockId: activation.blockId, delegation: activation.delegation },
  ]);
  expect(active.value.executions).toMatchObject([
    { activationId: execution.activationId, executionId: execution.executionId },
  ]);
  const navigation = await factory.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value.map((entry) => [entry.id, entry.outcome])).toStrictEqual([
    [fixture.active.id, null],
    [fixture.closed.id, "finished"],
  ]);
  const tasks = await factory.listTasks(fixture.project.id);
  assert(tasks.ok);
  expect(tasks.value.map((task) => [task.id, task.activeRunId])).toStrictEqual(
    fixture.tasks.map((task) => [task.id, task.activeRunId]),
  );
});

// The captured active Run's only worker has no outgoing connection, so no later launch exists; its
// running activation must instead be verified against the captured worker settings, not the edited Agent.
it("an upgraded active Run recovers its worker against the Agent revision captured before the edit", async (c) => {
  // Arrange
  const fixture = await releasedUpgradeData(c);
  const factory = await fixture.h.open({ t3: fixture.t3, connectionRetryMs: 60_000 });
  const [execution] = fixture.active.executions;
  assert(execution);
  const thread = fixture.active.threadBindings.find(
    (binding) => binding.blockId === execution.blockId,
  )?.threadId;
  assert(thread);
  const edited = await factory.updateAgent(fixture.agent.id, {
    name: fixture.agent.name,
    prompt: fixture.agent.prompt,
    expectedRevision: fixture.agent.revision,
    execution: { ...fixture.agent.execution, modelId: "gpt-6.1-terra" },
  });
  assert(edited.ok);
  const observation = (status: string) => ({
    threadId: thread,
    projectId: fixture.project.projectId,
    workspaceRoot: fixture.project.workspaceRoot,
    link: `t3://threads/${thread}`,
    activeRunId: status === "running" ? execution.executionId : null,
    latestRunId: execution.executionId,
    pendingRequestCount: 0,
    recentRuns: [{ runId: execution.executionId, status, ordinal: 1 }],
  });
  // The capture recorded quiet tree evidence only for the closed Run's worker.
  fixture.t3.descendantEvidence.set(thread, {
    parentThreadId: thread,
    descendants: [],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Bounded fixture scan",
  });
  fixture.t3.executionObservations.set(thread, observation("running"));
  fixture.t3.delegationActivities.set(thread, {
    threadId: thread,
    projectId: fixture.project.projectId,
    complete: true,
    invocations: [],
  });
  bindThreadReportCaller(
    fixture.t3,
    fixture.project.projectId,
    thread,
    execution.executionId,
    "worker-report",
  );
  assert((await factory.reconcileRuns()).ok);

  // Act
  const reported = await factory.runtime.submit(workerFinal());
  fixture.t3.executionObservations.set(thread, observation("completed"));
  fixture.t3.delegatedSettlements.set(JSON.stringify([thread, execution.executionId]), {
    threadId: thread,
    runId: execution.executionId,
    state: "settled",
    status: "completed",
    resultRun: { runId: execution.executionId, status: "completed" },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
  fixture.t3.engineStatus = "completed";
  assert((await factory.reconcileRuns()).ok);

  // Assert
  expect(reported.code).toBe("ACCEPTED");
  const run = await factory.getRun(fixture.active.id);
  assert(run.ok);
  expect(run.value.definitions.agents.map((agent) => agent.execution.modelId)).toStrictEqual([
    "gpt-6.1-sol",
  ]);
  expect(run.value.outcome).toBe("finished");
  expect(run.value.closedAt).not.toBeNull();
});

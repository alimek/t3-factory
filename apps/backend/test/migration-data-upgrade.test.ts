import { assert, expect, it } from "@effect/vitest";
import { capturedDefinitions, releasedUpgradeData } from "./support/released-upgrade.ts";

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

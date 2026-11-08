import { assert, expect, it } from "@effect/vitest";
import { capturedDefinitions, releasedUpgradeData } from "./support/released-upgrade.ts";

it("upgrading v0.2.0 keeps clients, definitions and closed Run history and removes the open Run", async (c) => {
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
  // Report keys belonged to per-turn report authority and are no longer part of Run detail.
  const reports = closed.reports.map(({ key: _key, ...report }) => report);
  expect(await factory.getRun(fixture.closed.id)).toStrictEqual({
    ok: true,
    value: { ...closed, reports, definitions: capturedDefinitions(closedSnapshot) },
  });
  const active = await factory.getRun(fixture.active.id);
  assert(!active.ok);
  expect(active.error.code).toBe("not_found");
  const navigation = await factory.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value.map((entry) => [entry.id, entry.outcome])).toStrictEqual([
    [fixture.closed.id, "finished"],
  ]);
  const tasks = await factory.listTasks(fixture.project.id);
  assert(tasks.ok);
  expect(tasks.value.map((task) => task.id)).toStrictEqual([fixture.closed.task.id]);
});

import { assert, expect, it } from "@effect/vitest";
import { mainUpgradeData } from "./support/main-upgrade.ts";

it("upgrading deletes open Runs and preserves clients, Flows, Agents and Tasks", async (c) => {
  // Arrange
  const fixture = await mainUpgradeData(c);

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
  expect(await factory.getFlow(fixture.flow.id)).toStrictEqual({ ok: true, value: fixture.flow });
  const flows = await factory.listFlows();
  assert(flows.ok);
  expect(flows.value.map((flow) => flow.name)).toStrictEqual([
    "Retained current work",
    "Single worker",
  ]);
  expect(flows.value[0]?.graph.connections).toStrictEqual([
    { sourceBlockId: "worker", exitId: "done", targetBlockId: "reviewer" },
  ]);
  const agent = await factory.getAgent(fixture.agent.id);
  assert(agent.ok);
  expect(agent.value).toMatchObject(fixture.agent);
  expect(agent.value).not.toHaveProperty("coordinator");
  const run = await factory.getRun(fixture.before.id);
  assert(!run.ok);
  expect(run.error.code).toBe("not_found");
  const current = await factory.getRun(fixture.current.id);
  assert(!current.ok);
  expect(current.error.code).toBe("not_found");
  const navigation = await factory.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value.map((entry) => entry.id)).toStrictEqual([]);
  const tasks = await factory.listTasks(fixture.project.id);
  assert(tasks.ok);
  expect(tasks.value.find((task) => task.id === fixture.before.task.id)).toMatchObject({
    ...fixture.before.task,
    activeRunId: null,
    latestRun: null,
    runs: [],
  });
  expect(tasks.value.find((task) => task.id === fixture.current.task.id)).toMatchObject({
    id: fixture.current.task.id,
    activeRunId: null,
    runs: [],
  });
});

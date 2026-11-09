import { assert, expect, it } from "@effect/vitest";
import { flowExitsUpgradeData, upgradedGraph } from "./support/flow-exits-upgrade.ts";

it("upgrading outcome exits keeps Agent block exits as Flow-local exits, maps Human exits to Approve and Request changes with merged wires, and keeps in-progress and finished Runs with their history", async (c) => {
  // Arrange
  const fixture = await flowExitsUpgradeData(c);
  const graph = upgradedGraph(fixture.agent.id, fixture.flow.graph.flowInput);

  // Act
  const factory = await fixture.h.open({ t3: fixture.t3, connectionRetryMs: 60_000 });

  // Assert
  const flow = await factory.getFlow(fixture.flow.id);
  assert(flow.ok);
  expect(flow.value.revision).toBe(fixture.flow.revision);
  expect(flow.value.graph).toStrictEqual(graph);
  expect(flow.value.readiness).toStrictEqual({ ready: true, issues: [] });
  expect(await factory.getAgent(fixture.agent.id)).toMatchObject({
    ok: true,
    value: { revision: fixture.agent.revision, exits: [] },
  });
  const finished = await factory.getRun(fixture.finished.id);
  assert(finished.ok);
  expect(finished.value.lifecycle).toBe("settled");
  expect(finished.value.definitions.flow.graph).toStrictEqual(graph);
  expect(finished.value.definitions.agents).toMatchObject([{ id: fixture.agent.id, exits: [] }]);
  expect(finished.value.reports).toStrictEqual(fixture.finished.reports);
  expect(finished.value.humanOccurrences).toMatchObject([{ state: "answered", exitId: "approve" }]);
  expect(finished.value.intents).toMatchObject([
    { blockId: "worker", kind: "launch", exitId: null },
    { blockId: "review", kind: "handoff", exitId: "done" },
    { blockId: "deploy", kind: "launch", exitId: "approve" },
    { blockId: "notify", kind: "launch", exitId: "approve" },
  ]);
  const answered = await factory.getRun(fixture.answered.id);
  assert(answered.ok);
  expect(answered.value.definitions.flow.graph).toStrictEqual(graph);
  expect(answered.value.reports).toStrictEqual(fixture.answered.reports);
  expect(answered.value).toMatchObject({
    lifecycle: "active",
    humanOccurrences: [{ state: "answered", exitId: "request-changes" }],
    intents: [
      { blockId: "worker", kind: "launch", exitId: null },
      { blockId: "review", kind: "handoff", exitId: "done" },
      { blockId: "worker", kind: "send", exitId: "request-changes", state: "acknowledged" },
    ],
  });
  const pending = await factory.getRun(fixture.pending.id);
  assert(pending.ok);
  expect(pending.value).toMatchObject({
    lifecycle: "active",
    humanOccurrences: [{ id: fixture.pending.humanOccurrences[0]!.id, state: "pending" }],
    attention: [{ kind: "human", settledAt: null }],
  });
});

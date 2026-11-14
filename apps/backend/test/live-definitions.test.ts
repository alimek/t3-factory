import { assert, expect, it } from "@effect/vitest";
import type { DefinitionsLiveMessage, FlowDraft } from "@t3-factory/contracts";
import { flowWithAgent } from "./support/domain-setup.ts";
import { liveClient, subscribe } from "./support/live.ts";
import { remoteServer } from "./support/remote-clients.ts";
import { flowInput } from "./support/scenarios.ts";

const changes = (messages: readonly DefinitionsLiveMessage[]) =>
  messages.filter((message) => message._tag === "changed");

it("the Studio snapshot holds every Agent with its settings status and every Flow with its readiness", async (c) => {
  // Arrange
  const { factory } = await flowWithAgent(c);

  // Act
  const definitions = subscribe(c, factory.live.watchDefinitions());

  // Assert
  const [snapshot] = await definitions.until((messages) => messages.length > 0);
  const agents = await factory.listAgents();
  const flows = await factory.listFlows();
  assert(agents.ok && flows.ok);
  expect(snapshot).toStrictEqual({
    _tag: "snapshot",
    definitions: { agents: agents.value, flows: flows.value },
  } satisfies DefinitionsLiveMessage);
});

it("an Agent save reaches Studio subscribers with the affected Flow's readiness at an unchanged Flow revision", async (c) => {
  // Arrange
  const { factory, created, agent, unconnectedGraph } = await flowWithAgent(c);
  assert(created.ok);
  const ready = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: created.value.revision,
    workspace: created.value.workspace,
    graph: { ...unconnectedGraph, flowInput: flowInput("coder") },
  });
  assert(ready.ok && ready.value.readiness.ready);
  const definitions = subscribe(c, factory.live.watchDefinitions());
  await definitions.until((messages) => messages.length > 0);

  // Act
  const saved = await factory.updateAgent(agent.id, {
    name: agent.name,
    prompt: agent.prompt,
    execution: agent.execution,
    exits: [{ id: "finished", name: "finished", description: "", messageRequired: false }],
    expectedRevision: agent.revision,
  });

  // Assert
  assert(saved.ok);
  const [changed] = changes(await definitions.until((messages) => changes(messages).length > 0));
  assert(changed?._tag === "changed");
  expect(changed.agents).toStrictEqual({ upserts: [saved.value], removals: [] });
  expect(changed.flows?.upserts).toHaveLength(1);
  expect(changed.flows?.upserts[0]?.revision).toBe(ready.value.revision);
  expect(changed.flows?.upserts[0]?.readiness.ready).toBe(false);
});

it("a removed Agent reaches Studio subscribers as a removal without another read", async (c) => {
  // Arrange
  const { factory, agent } = await flowWithAgent(c);
  const definitions = subscribe(c, factory.live.watchDefinitions());
  await definitions.until((messages) => messages.length > 0);

  // Act
  const removed = await factory.removeAgent(agent.id);

  // Assert
  assert(removed.ok);
  const delivered = await definitions.until((messages) => changes(messages).length > 0);
  expect(changes(delivered)).toStrictEqual([
    { _tag: "changed", agents: { upserts: [], removals: [agent.id] } },
  ] satisfies DefinitionsLiveMessage[]);
});

it("an approved client's Studio subscription receives a Flow the host creates", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const definitions = subscribe(c, (await liveClient(c, laptop.live())).WatchDefinitions());
  await definitions.until((messages) => messages.length > 0);

  // Act
  const created = await server.host<FlowDraft>("POST", "/api/flows", {
    name: "Created on the host",
  });

  // Assert
  assert(created.body.ok);
  const delivered = await definitions.until((messages) => changes(messages).length > 0);
  expect(changes(delivered)).toStrictEqual([
    { _tag: "changed", flows: { upserts: [created.body.value], removals: [] } },
  ] satisfies DefinitionsLiveMessage[]);
});

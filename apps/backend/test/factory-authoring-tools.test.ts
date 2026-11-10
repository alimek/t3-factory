import { expect, it } from "@effect/vitest";
import { authoringMcpClient, toolReply } from "./support/factory-mcp.ts";
import { assertOk, sampleAgentInput } from "./support/domain-setup.ts";

it("a partial-position save arranges the whole graph after creating a ready Flow at revision 1 without positions", async (c) => {
  // Arrange
  const { client } = await authoringMcpClient(c);
  const capabilities = toolReply(
    await client.callTool({ name: "factory_get_agent_capabilities", arguments: {} }),
  );
  const [provider] = capabilities.providers;
  const agent = toolReply(
    await client.callTool({
      name: "factory_create_agent",
      arguments: {
        ...sampleAgentInput("Coder"),
        execution: {
          environmentId: capabilities.environments[0].environmentId,
          providerInstanceId: provider.providerInstanceId,
          modelId: provider.models[0].id,
          modelOptions: [],
        },
      },
    }),
  );
  const graph = {
    flowInput: { targetBlockIds: ["flow-input"] },
    blocks: [
      {
        id: "flow-input",
        kind: "agent",
        name: "Coder",
        agentId: agent.id,
        hiddenExitIds: [],
        localExits: [],
      },
    ],
    connections: [],
  };
  const workspace = { mode: "worktree", base: { kind: "ref", ref: "origin/develop" } };

  const created = await client.callTool({
    name: "factory_create_flow",
    arguments: { name: "Change", graph, workspace },
  });

  expect(created.isError).toBe(false);
  const flow = toolReply(created);
  expect(flow).toMatchObject({ revision: 1, workspace, readiness: { ready: true, issues: [] } });
  expect(flow.graph).toMatchObject(graph);
  expect(flow.graph.flowInput.position.x).toBeGreaterThanOrEqual(-10000);
  expect(flow.graph.flowInput.position.x).toBeLessThanOrEqual(10000);
  expect(flow.graph.flowInput.position.y).toBeGreaterThanOrEqual(-10000);
  expect(flow.graph.flowInput.position.y).toBeLessThanOrEqual(10000);
  expect(flow.graph.blocks[0].position.x).toBeGreaterThanOrEqual(-10000);
  expect(flow.graph.blocks[0].position.x).toBeLessThanOrEqual(10000);
  expect(flow.graph.blocks[0].position.y).toBeGreaterThanOrEqual(-10000);
  expect(flow.graph.blocks[0].position.y).toBeLessThanOrEqual(10000);
  expect(
    toolReply(
      await client.callTool({ name: "factory_check_flow", arguments: { flowId: flow.id } }),
    ),
  ).toStrictEqual({ ready: true, issues: [] });
  expect(provider.reporting.supported).toBe(true);
  expect(agent.settingsStatus).toStrictEqual({
    environment: { state: "available" },
    provider: { state: "available" },
    model: { state: "available" },
    options: [],
  });
  // Act
  const result = await client.callTool({
    name: "factory_save_flow",
    arguments: {
      flowId: flow.id,
      name: flow.name,
      expectedRevision: flow.revision,
      graph: { ...graph, flowInput: { ...graph.flowInput, position: { x: -10000, y: 10000 } } },
    },
  });

  // Assert
  expect(result.isError).toBe(false);
  const saved = toolReply(result);
  expect(saved).toMatchObject({ revision: 2, workspace, readiness: { ready: true, issues: [] } });
  expect(saved.graph).toStrictEqual(flow.graph);
  expect(
    toolReply(await client.callTool({ name: "factory_get_flow", arguments: { flowId: flow.id } })),
  ).toStrictEqual(saved);
});

it("an Agent save on a revision Studio has replaced is refused with a conflict and a next step", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const opened = assertOk(await factory.createAgent(sampleAgentInput("Coder")));
  const studio = assertOk(
    await factory.updateAgent(opened.id, {
      ...sampleAgentInput("Coder"),
      prompt: "Studio's edit",
      expectedRevision: opened.revision,
    }),
  );

  // Act
  const result = await client.callTool({
    name: "factory_save_agent",
    arguments: {
      ...sampleAgentInput("Coder"),
      agentId: opened.id,
      prompt: "The agent's edit",
      expectedRevision: opened.revision,
    },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toStrictEqual({
    code: "conflict",
    message: expect.any(String),
    issues: [{ code: "stale_revision", path: "expectedRevision", message: expect.any(String) }],
    next: "Read the Agent with factory_get_agent, reapply your change and save with its revision.",
  });
  expect(assertOk(await factory.getAgent(opened.id))).toMatchObject({
    revision: studio.revision,
    prompt: "Studio's edit",
  });
});

it("an Agent save choosing a provider without Factory reporting support is refused and keeps the revision", async (c) => {
  // Arrange
  const { factory, t3, client } = await authoringMcpClient(c);
  t3.controlledProviders.push({
    ...t3.controlledProviders[0]!,
    providerInstanceId: "future-main",
    driverKind: "future",
  });
  const saved = assertOk(await factory.createAgent(sampleAgentInput("Coder")));

  // Act
  const result = await client.callTool({
    name: "factory_save_agent",
    arguments: {
      ...sampleAgentInput("Coder"),
      agentId: saved.id,
      expectedRevision: saved.revision,
      execution: { ...saved.execution, providerInstanceId: "future-main" },
    },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toStrictEqual({
    code: "validation",
    message: expect.any(String),
    issues: [
      {
        code: "harness_unsupported",
        path: "execution.providerInstanceId",
        message: expect.any(String),
      },
    ],
    next: "Fix the listed issue paths and call the tool again.",
  });
  expect(assertOk(await factory.getAgent(saved.id))).toMatchObject({
    revision: saved.revision,
    execution: saved.execution,
  });
});

it("a stale Flow save whose graph is too large to arrange is refused as a conflict before any layout", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const opened = assertOk(await factory.createFlow({ name: "Long" }));
  const studio = assertOk(
    await factory.updateFlow(opened.id, {
      name: "Studio's edit",
      expectedRevision: opened.revision,
      graph: opened.graph,
    }),
  );
  const ids = Array.from({ length: 80 }, (_, index) => `step-${index}`);

  // Act
  const result = await client.callTool({
    name: "factory_save_flow",
    arguments: {
      flowId: opened.id,
      name: "The agent's edit",
      expectedRevision: opened.revision,
      graph: {
        flowInput: { targetBlockIds: [] },
        blocks: ids.map((id) => ({ id, kind: "human", name: id })),
        connections: ids.slice(1).map((id, index) => ({
          sourceBlockId: ids[index],
          exitId: "approve",
          targetBlockId: id,
        })),
      },
    },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toMatchObject({
    code: "conflict",
    issues: [{ code: "stale_revision", path: "expectedRevision", message: expect.any(String) }],
    next: expect.any(String),
  });
  expect(assertOk(await factory.getFlow(opened.id))).toMatchObject({
    revision: studio.revision,
    name: "Studio's edit",
  });
});

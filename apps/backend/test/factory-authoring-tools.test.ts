import { assert, expect, it } from "@effect/vitest";
import { authoringMcpClient, toolReply } from "./support/factory-mcp.ts";
import { assertOk, sampleAgentInput } from "./support/domain-setup.ts";

it("an Agent and a Flow created through Factory MCP check ready, and Studio reads the saved Flow", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
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
  const flow = toolReply(
    await client.callTool({ name: "factory_create_flow", arguments: { name: "Change" } }),
  );
  const graph = {
    flowInput: { position: { x: 0, y: 0 }, targetBlockIds: ["coder"] },
    blocks: [
      {
        id: "coder",
        kind: "agent",
        name: "Coder",
        agentId: agent.id,
        position: { x: 240, y: 0 },
        hiddenExitIds: [],
        localExits: [],
      },
    ],
    connections: [],
  };
  const saved = await client.callTool({
    name: "factory_save_flow",
    arguments: { flowId: flow.id, expectedRevision: flow.revision, name: flow.name, graph },
  });
  assert(!saved.isError);

  // Act
  const check = await client.callTool({
    name: "factory_check_flow",
    arguments: { flowId: flow.id },
  });

  // Assert
  expect(check.isError).toBe(false);
  expect(toolReply(check)).toStrictEqual({ ready: true, issues: [] });
  expect(provider.reporting.supported).toBe(true);
  expect(agent.settingsStatus).toStrictEqual({
    environment: { state: "available" },
    provider: { state: "available" },
    model: { state: "available" },
    options: [],
  });
  expect(assertOk(await factory.getFlow(flow.id))).toMatchObject({ revision: 2, graph });
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

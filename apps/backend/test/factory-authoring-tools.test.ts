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

it("an MCP-created Flow with an eight-day Wait saves with Studio's readiness gap and arranged positions", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const agent = assertOk(await factory.createAgent(sampleAgentInput("Coder")));
  const graph = {
    flowInput: { targetBlockIds: ["coder"] },
    blocks: [
      {
        id: "coder",
        kind: "agent",
        name: "Coder",
        agentId: agent.id,
        hiddenExitIds: [],
        localExits: [],
      },
      { id: "pause", kind: "wait", name: "Cool down", duration: { amount: 8, unit: "days" } },
    ],
    connections: [{ sourceBlockId: "coder", exitId: "done", targetBlockId: "pause" }],
  };

  // Act
  const result = await client.callTool({
    name: "factory_create_flow",
    arguments: { name: "Delayed review", graph },
  });

  // Assert
  expect(result.isError).toBe(false);
  const flow = toolReply(result);
  expect(flow.readiness.issues).toStrictEqual([
    {
      code: "wait_duration_range",
      path: "graph.blocks.1.duration",
      message: "Cool down must wait from 1 minute to 7 days.",
    },
  ]);
  expect(flow.graph.blocks[1]).toMatchObject({
    kind: "wait",
    duration: { amount: 8, unit: "days" },
    position: { x: expect.any(Number), y: expect.any(Number) },
  });
  expect(assertOk(await factory.getFlow(flow.id))).toStrictEqual(flow);
});

it("factory_create_flow, factory_save_flow and factory_get_flow round-trip an Agent block's Revisit instruction without a readiness issue", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const agent = assertOk(await factory.createAgent(sampleAgentInput("Reviewer")));
  const reviewer = {
    id: "review",
    kind: "agent",
    name: "Review",
    agentId: agent.id,
    hiddenExitIds: [],
    localExits: [],
  };
  const graph = (revisitInstruction: string) => ({
    flowInput: { targetBlockIds: ["review"] },
    blocks: [{ ...reviewer, revisitInstruction }],
    connections: [],
  });
  const created = toolReply(
    await client.callTool({
      name: "factory_create_flow",
      arguments: { name: "Review once", graph: graph("  Check every finding again.  ") },
    }),
  );
  expect(created.graph.blocks[0].revisitInstruction).toBe("Check every finding again.");

  // Act
  const result = await client.callTool({
    name: "factory_save_flow",
    arguments: {
      flowId: created.id,
      name: created.name,
      expectedRevision: created.revision,
      graph: graph("Verify the fixes and the newly affected scope."),
    },
  });

  // Assert
  expect(result.isError).toBe(false);
  const saved = toolReply(result);
  expect(saved.graph.blocks[0].revisitInstruction).toBe(
    "Verify the fixes and the newly affected scope.",
  );
  expect(saved.readiness).toStrictEqual({ ready: true, issues: [] });
  expect(
    toolReply(
      await client.callTool({ name: "factory_get_flow", arguments: { flowId: created.id } }),
    ),
  ).toStrictEqual(saved);
  expect(
    toolReply(
      await client.callTool({ name: "factory_check_flow", arguments: { flowId: created.id } }),
    ),
  ).toStrictEqual({ ready: true, issues: [] });
});

it("removing an unused Agent replies with its id and the Agent then reads as not found", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const agent = assertOk(await factory.createAgent(sampleAgentInput("Coder")));

  // Act
  const result = await client.callTool({
    name: "factory_remove_agent",
    arguments: { agentId: agent.id },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result)).toStrictEqual({ agentId: agent.id, removed: true });
  expect(
    toolReply(
      await client.callTool({ name: "factory_get_agent", arguments: { agentId: agent.id } }),
    ),
  ).toMatchObject({ code: "not_found" });
});

it("removing an Agent two current Flows place is refused with one issue per Flow and keeps the Agent", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const agent = assertOk(await factory.createAgent(sampleAgentInput("Coder")));
  const placing = (name: string) =>
    factory.createFlow({
      name,
      graph: {
        flowInput: { targetBlockIds: ["coder"] },
        blocks: [
          {
            id: "coder",
            kind: "agent",
            name: "Coder",
            agentId: agent.id,
            hiddenExitIds: [],
            localExits: [],
          },
        ],
        connections: [],
      },
    });
  const review = assertOk(await placing("Review"));
  const change = assertOk(await placing("Change"));

  // Act
  const result = await client.callTool({
    name: "factory_remove_agent",
    arguments: { agentId: agent.id },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toStrictEqual({
    code: "conflict",
    message: expect.any(String),
    issues: [
      {
        code: "agent_in_use",
        path: "agentId",
        message: `Flow "Change" (${change.id}) places this Agent.`,
      },
      {
        code: "agent_in_use",
        path: "agentId",
        message: `Flow "Review" (${review.id}) places this Agent.`,
      },
    ],
    next: "Nothing was removed. Ask the user before editing or removing the Flows that place this Agent, unless they already authorized those exact changes; never rewrite Flows on your own.",
  });
  expect(assertOk(await factory.getAgent(agent.id))).toMatchObject({ revision: agent.revision });
});

it("removing a Flow replies with its id and the Flow then reads as not found", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const flow = assertOk(await factory.createFlow({ name: "Change" }));

  // Act
  const result = await client.callTool({
    name: "factory_remove_flow",
    arguments: { flowId: flow.id },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result)).toStrictEqual({ flowId: flow.id, removed: true });
  expect(
    toolReply(await client.callTool({ name: "factory_get_flow", arguments: { flowId: flow.id } })),
  ).toMatchObject({ code: "not_found" });
});

it("removing a Flow that Studio already removed succeeds again", async (c) => {
  // Arrange
  const { factory, client } = await authoringMcpClient(c);
  const flow = assertOk(await factory.createFlow({ name: "Change" }));
  assertOk(await factory.removeFlow(flow.id));

  // Act
  const result = await client.callTool({
    name: "factory_remove_flow",
    arguments: { flowId: flow.id },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result)).toStrictEqual({ flowId: flow.id, removed: true });
});

it("a removal without an id is a validation error at the id path", async (c) => {
  // Arrange
  const { client } = await authoringMcpClient(c);

  // Act
  const result = await client.callTool({ name: "factory_remove_agent", arguments: {} });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toStrictEqual({
    code: "validation",
    message: expect.any(String),
    issues: [{ code: "invalid_id", path: "agentId", message: expect.any(String) }],
    next: "Fix the listed issue paths and call the tool again.",
  });
});

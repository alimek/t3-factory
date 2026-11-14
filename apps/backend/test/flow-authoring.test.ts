import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import { factoryHarness } from "./support/factory.ts";
import { flowWithAgent, readFlowAfterRestart, validationFlow } from "./support/domain-setup.ts";
import { flowInput, humanStep } from "./support/scenarios.ts";

it("an incomplete graph draft saves with the Flow input connection outstanding", async (context) => {
  // Arrange
  const { factory, created, unconnectedGraph } = await flowWithAgent(context);

  // Act
  const draft = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: unconnectedGraph,
  });

  // Assert
  assert(draft.ok);
  expect(draft.value.revision).toBe(2);
  expect(draft.value.readiness.ready).toBe(false);
  expect(draft.value.readiness.issues[0]?.code).toBe("flow_input_required");
  expect(draft.value.readiness.issues[0]?.path).toBe("graph.flowInput.targetBlockIds");
});

it("connecting the Flow input to an Agent makes a saved graph draft ready", async (context) => {
  // Arrange
  const { factory, created, unconnectedGraph } = await flowWithAgent(context);
  assert(
    (
      await factory.updateFlow(created.value.id, {
        name: created.value.name,
        expectedRevision: 1,
        workspace: created.value.workspace,
        graph: unconnectedGraph,
      })
    ).ok,
  );

  // Act
  const ready = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 2,
    workspace: created.value.workspace,
    graph: { ...unconnectedGraph, flowInput: flowInput("coder") },
  });

  // Assert
  assert(ready.ok);
  expect(ready.value.readiness.ready).toBe(true);
});

it("a saved graph draft keeps its blocks, hidden and local exits, connections, Flow input order and custom worktree ref after restart", async (context) => {
  // Arrange
  const { harness, factory, created, unconnectedGraph } = await flowWithAgent(context);
  const [coder, human] = unconnectedGraph.blocks;
  const writer = {
    id: "writer",
    kind: "agent" as const,
    name: "",
    agentId: null,
    position: { x: -120.5, y: 7.25 },
    hiddenExitIds: ["review", "draft"],
    localExits: [
      { id: "done", name: "", description: "", messageRequired: true },
      { id: "accepted", name: "Accepted", description: "Ship it", messageRequired: false },
    ],
  };
  const saved = await factory.updateFlow(created.value.id, {
    name: "Ordered draft",
    expectedRevision: 1,
    workspace: { mode: "worktree", base: { kind: "ref", ref: "origin/develop" } },
    graph: {
      flowInput: { position: { x: -40.5, y: 12 }, targetBlockIds: ["writer", "coder"] },
      blocks: [writer, human, coder],
      connections: [
        { sourceBlockId: "writer", exitId: "accepted", targetBlockId: "human" },
        ...unconnectedGraph.connections,
        { sourceBlockId: "writer", exitId: "done", targetBlockId: "writer" },
      ],
    },
  });
  assert(saved.ok);
  await factory.close();

  // Act
  const recovered = await readFlowAfterRestart(harness, created.value.id);

  // Assert
  expect(recovered).toStrictEqual(saved);
});

it("updateFlow rejects a stale editor with conflict and leaves the saved revision", async (context) => {
  // Arrange
  const { factory, created, unconnectedGraph } = await flowWithAgent(context);
  assert(
    (
      await factory.updateFlow(created.value.id, {
        name: created.value.name,
        expectedRevision: 1,
        workspace: created.value.workspace,
        graph: unconnectedGraph,
      })
    ).ok,
  );
  const ready = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 2,
    workspace: created.value.workspace,
    graph: { ...unconnectedGraph, flowInput: flowInput("coder") },
  });
  assert(ready.ok);

  // Act
  const stale = await factory.updateFlow(created.value.id, {
    name: "Stale",
    expectedRevision: 2,
    workspace: { mode: "checkout" },
    graph: unconnectedGraph,
  });

  // Assert
  assert(!stale.ok);
  expect(stale.error.code).toBe("conflict");
  expect(await factory.getFlow(created.value.id)).toStrictEqual(ready);
});

it("choosing the project checkout appends a revision that reads checkout", async (context) => {
  // Arrange
  const { factory, created } = await flowWithAgent(context);

  // Act
  const saved = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: { mode: "checkout" },
    graph: created.value.graph,
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.revision).toBe(2);
  expect(saved.value.workspace).toStrictEqual({ mode: "checkout" });
  expect(await factory.getFlow(created.value.id)).toStrictEqual(saved);
});

it("a custom worktree ref read as an option is rejected and appends no revision", async (context) => {
  // Arrange
  const { factory, created } = await flowWithAgent(context);

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: { mode: "worktree", base: { kind: "ref", ref: " --upload-pack=x " } },
    graph: created.value.graph,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues[0]?.path).toBe("workspace.base.ref");
  expect(await factory.getFlow(created.value.id)).toStrictEqual(created);
});

it("validateFlow reports a missing agent reference before save", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = { flowInput: flowInput("a"), blocks: [block], connections: [] };

  // Act
  const missing = await factory.validateFlow({
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(missing.ok);
  expect(missing.value.issues[0]?.code).toBe("agent_required");
});

it("validateFlow names the saved Agents its readiness was checked against", async (context) => {
  // Arrange
  const { factory, created, agent, unconnectedGraph } = await flowWithAgent(context);
  assert(created.ok);

  // Act
  const validated = await factory.validateFlow({
    name: created.value.name,
    expectedRevision: created.value.revision,
    workspace: created.value.workspace,
    graph: unconnectedGraph,
  });

  // Assert
  assert(validated.ok);
  expect(validated.value.agentGeneration).toBe(`${agent.id}:${agent.revision}`);
});

it("updateFlow rejects duplicate block ids", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = { flowInput: flowInput("a"), blocks: [block, block], connections: [] };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  assert(result.error.issues.some((issue) => issue.code === "invalid_block_id"));
});

it("updateFlow rejects block prompt overrides", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = {
    flowInput: flowInput("a"),
    blocks: [{ ...block, prompt: "override" }],
    connections: [],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  assert(result.error.issues.some((issue) => issue.code === "block_overrides_forbidden"));
});

it("updateFlow rejects dangling connections", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = {
    flowInput: flowInput("a"),
    blocks: [block],
    connections: [{ sourceBlockId: "a", exitId: "e", targetBlockId: "absent" }],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  assert(result.error.issues.some((issue) => issue.code === "invalid_connection"));
});

it("updateFlow rejects a Human connection from an exit other than Approve or Request changes", async (context) => {
  // Arrange
  const { factory, created, unconnectedGraph } = await flowWithAgent(context);
  const graph = {
    ...unconnectedGraph,
    connections: [{ sourceBlockId: "human", exitId: "retry", targetBlockId: "coder" }],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["invalid_connection", "graph.connections.0"],
  ]);
  expect(await factory.getFlow(created.value.id)).toStrictEqual(created);
});

it("updateFlow rejects a Flow input target that is not in the graph", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = { flowInput: flowInput("absent"), blocks: [block], connections: [] };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]?.code).toBe("invalid_flow_input_target");
  expect(result.error.issues[0]?.path).toBe("graph.flowInput.targetBlockIds.0");
});

it("updateFlow rejects a Human step as a Flow input target", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const human = humanStep("review", "Review", block.position);
  const graph = { flowInput: flowInput("review"), blocks: [block, human], connections: [] };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]?.code).toBe("invalid_flow_input_target");
});

it("updateFlow reports a block kind named after an object member as invalid instead of failing", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = {
    flowInput: flowInput("a"),
    blocks: [block, { id: "odd", name: "Odd", kind: "toString", position: block.position }],
    connections: [],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: graph as never,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["invalid_block_kind", "graph.blocks.1.kind"],
  ]);
});

it("concurrent Flow edits allow exactly one successful revision advance", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const input = {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: { flowInput: flowInput("a"), blocks: [block], connections: [] },
  };
  assert((await factory.updateFlow(created.value.id, input)).ok);

  // Act
  const raced = await Promise.all([
    factory.updateFlow(created.value.id, { ...input, name: "One", expectedRevision: 2 }),
    factory.updateFlow(created.value.id, { ...input, name: "Two", expectedRevision: 2 }),
  ]);

  // Assert
  expect(raced.filter((r) => r.ok).length).toBe(1);
  expect(raced.filter((r) => !r.ok && r.error.code === "conflict").length).toBe(1);
});

it("readiness identifies unfinished and unreachable blocks without rejecting draft saves", async (context) => {
  // Arrange
  const factory = await (await factoryHarness(context)).open({ t3: new ControlledT3() });
  const created = await factory.createFlow({ name: "Incomplete work" });
  assert(created.ok);

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: {
      flowInput: flowInput("entry"),
      connections: [],
      blocks: [
        {
          id: "entry",
          kind: "agent",
          agentId: null,
          name: "Worker",
          position: { x: 0, y: 0 },
          hiddenExitIds: [],
          localExits: [],
        },
        {
          id: "reviewer",
          kind: "agent",
          agentId: null,
          name: "",
          position: { x: 400, y: 0 },
          hiddenExitIds: [],
          localExits: [{ id: "custom", name: "", description: "", messageRequired: true }],
        },
      ],
    },
  });

  // Assert
  assert(result.ok);
  expect(result.value.readiness.ready).toBe(false);
  expect(result.value.readiness.issues.map((i) => [i.code, i.path])).toStrictEqual([
    ["agent_required", "graph.blocks.0.agentId"],
    ["exit_required", "graph.blocks.0"],
    ["block_name_required", "graph.blocks.1.name"],
    ["agent_required", "graph.blocks.1.agentId"],
    ["exit_name_required", "graph.blocks.1.localExits.0.name"],
    ["unreachable_block", "graph.blocks.1"],
  ]);
  expect(result.value.revision).toBe(2);
});

it("local exit IDs matching visible or hidden Agent exits allow saving but block Start", async (context) => {
  // Arrange
  const { f, flow, input, project } = await prepared(context);
  const [worker] = flow.graph.blocks;
  assert(worker?.kind === "agent");
  const localExits = [
    { id: "done", name: "Local result", description: "", messageRequired: false },
  ];
  const saved = await f.updateFlow(flow.id, {
    ...flow,
    expectedRevision: flow.revision,
    graph: {
      ...flow.graph,
      flowInput: { ...flow.graph.flowInput, targetBlockIds: [worker.id, "hidden-worker"] },
      blocks: [
        { ...worker, localExits },
        {
          ...worker,
          id: "hidden-worker",
          name: "Hidden worker",
          hiddenExitIds: ["done"],
          localExits,
        },
      ],
    },
  });
  assert(saved.ok);
  expect(saved.value.readiness).toStrictEqual({
    ready: false,
    issues: [
      {
        code: "exit_id_conflict",
        path: "graph.blocks.0.localExits.0.id",
        message:
          'Entry worker: local exit "Local result" has the same ID as an exit from its Agent. Remove and recreate the local exit.',
      },
      {
        code: "exit_id_conflict",
        path: "graph.blocks.1.localExits.0.id",
        message:
          'Hidden worker: local exit "Local result" has the same ID as an exit from its Agent. Remove and recreate the local exit.',
      },
    ],
  });

  // Act
  const started = await f.startRun(input);

  // Assert
  assert(!started.ok);
  expect(started.error.code).toBe("validation");
  expect(started.error.issues).toStrictEqual(saved.value.readiness.issues);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
});

it("an Agent block's Revisit instruction is saved trimmed and read back after restart", async (context) => {
  // Arrange
  const { harness, factory, created, unconnectedGraph } = await flowWithAgent(context);
  const [coder, human] = unconnectedGraph.blocks;
  const saved = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: {
      ...unconnectedGraph,
      blocks: [
        { ...coder!, revisitInstruction: "\n  Verify the fixes and the newly affected scope.  " },
        human!,
      ],
    },
  });
  assert(saved.ok);
  await factory.close();

  // Act
  const recovered = await readFlowAfterRestart(harness, created.value.id);

  // Assert
  expect(saved.value.graph.blocks[0]).toMatchObject({
    kind: "agent",
    revisitInstruction: "Verify the fixes and the newly affected scope.",
  });
  expect(recovered).toStrictEqual(saved);
});

it("a whitespace-only Revisit instruction is saved empty", async (context) => {
  // Arrange
  const { factory, created, unconnectedGraph } = await flowWithAgent(context);
  const [coder, human] = unconnectedGraph.blocks;

  // Act
  const saved = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: { ...unconnectedGraph, blocks: [{ ...coder!, revisitInstruction: " \n\t " }, human!] },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.graph.blocks[0]).toMatchObject({ kind: "agent", revisitInstruction: "" });
});

it("a Revisit instruction on a Human step is refused at its field path and appends no revision", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = {
    flowInput: flowInput("a"),
    blocks: [block, { ...humanStep("review", "Review"), revisitInstruction: "Check again." }],
    connections: [],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["invalid_revisit_instruction", "graph.blocks.1.revisitInstruction"],
  ]);
  expect(await factory.getFlow(created.value.id)).toStrictEqual(created);
});

it("a Revisit instruction over 120,000 characters is refused at its field path", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = {
    flowInput: flowInput("a"),
    blocks: [{ ...block, revisitInstruction: "x".repeat(120_001) }],
    connections: [],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues).toStrictEqual([
    {
      code: "invalid_revisit_instruction",
      path: "graph.blocks.0.revisitInstruction",
      message: "Enter a Revisit instruction up to 120,000 characters.",
    },
  ]);
});

it("a Revisit instruction that is not text is refused at its field path", async (context) => {
  // Arrange
  const { factory, created, block } = await validationFlow(context);
  const graph = {
    flowInput: flowInput("a"),
    blocks: [{ ...block, revisitInstruction: 42 }],
    connections: [],
  };

  // Act
  const result = await factory.updateFlow(created.value.id, {
    name: "Validation",
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: graph as never,
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["invalid_revisit_instruction", "graph.blocks.0.revisitInstruction"],
  ]);
});

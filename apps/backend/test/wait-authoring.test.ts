import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { agentBlock, connection, flowInput, waitStep } from "./support/scenarios.ts";

it("a Wait saves its name and duration and a Run captures them", async (c) => {
  // Arrange
  const f = await prepared(c);
  const graph = {
    flowInput: flowInput("worker"),
    blocks: [
      agentBlock("worker", "Worker", f.agent.id),
      waitStep("cool-down", "Cool down", { amount: 7, unit: "days" as const }),
      agentBlock("follow-up", "Follow-up", f.agent.id),
    ],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", "output", "follow-up"),
    ],
  };
  const saved = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    graph,
  });
  assert(saved.ok);

  // Act
  const started = await f.f.startRun(f.input);

  // Assert
  assert(started.ok);
  expect(saved.value.readiness).toStrictEqual({ ready: true, issues: [] });
  expect(started.value.definitions.flow.graph.blocks[1]).toStrictEqual({
    id: "cool-down",
    name: "Cool down",
    kind: "wait",
    duration: { amount: 7, unit: "days" },
    position: { x: 0, y: 0 },
  });
});

it("Wait durations from 1 minute through 7 days are ready in any unit", async (c) => {
  // Arrange
  const f = await prepared(c);

  // Act
  const saved = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    graph: {
      flowInput: flowInput("worker"),
      blocks: [
        agentBlock("worker", "Worker", f.agent.id),
        waitStep("minute", "One minute", { amount: 1, unit: "minutes" }),
        waitStep("hours", "A week in hours", { amount: 168, unit: "hours" }),
        waitStep("minutes", "A week in minutes", { amount: 10080, unit: "minutes" }),
      ],
      connections: [
        connection("worker", "done", "minute"),
        connection("minute", "output", "hours"),
        connection("hours", "output", "minutes"),
      ],
    },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.readiness).toStrictEqual({ ready: true, issues: [] });
});

it("a missing or out-of-range Wait duration and an unreachable Wait save as readiness issues", async (c) => {
  // Arrange
  const f = await prepared(c);

  // Act
  const saved = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    graph: {
      flowInput: flowInput("worker"),
      blocks: [
        agentBlock("worker", "Worker", f.agent.id),
        waitStep("unset", "Unset", { amount: null, unit: "hours" }),
        waitStep("too-short", "Too short", { amount: 0, unit: "minutes" }),
        waitStep("too-long", "Too long", { amount: 10081, unit: "minutes" }),
        waitStep("loose", "Loose", { amount: 8, unit: "days" }),
      ],
      connections: [
        connection("worker", "done", "unset"),
        connection("worker", "done", "too-short"),
        connection("worker", "done", "too-long"),
      ],
    },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.graph.blocks[1]).toMatchObject({ duration: { amount: null, unit: "hours" } });
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["wait_duration_required", "graph.blocks.1.duration.amount"],
    ["wait_duration_range", "graph.blocks.2.duration.amount"],
    ["wait_duration_range", "graph.blocks.3.duration.amount"],
    ["wait_duration_range", "graph.blocks.4.duration.amount"],
    ["unreachable_block", "graph.blocks.4"],
  ]);
});

it("a malformed Wait duration, unknown unit or extra Wait field is rejected without a revision", async (c) => {
  // Arrange
  const f = await prepared(c);
  const waits = [
    {
      ...waitStep("text", "Text", { amount: null, unit: "minutes" }),
      duration: { amount: "5", unit: "minutes" },
    },
    {
      ...waitStep("fraction", "Fraction", { amount: null, unit: "hours" }),
      duration: { amount: 1.5, unit: "hours" },
    },
    {
      ...waitStep("weeks", "Weeks", { amount: null, unit: "minutes" }),
      duration: { amount: 1, unit: "weeks" },
    },
    {
      ...waitStep("prompted", "Prompted", { amount: 5, unit: "minutes" }),
      prompt: "Wait politely.",
    },
  ];

  // Act
  const saved = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    graph: { flowInput: flowInput(), blocks: waits, connections: [] },
  });

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues?.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["invalid_wait_duration", "graph.blocks.0.duration.amount"],
    ["invalid_wait_duration", "graph.blocks.1.duration.amount"],
    ["invalid_wait_duration", "graph.blocks.2.duration.unit"],
    ["block_overrides_forbidden", "graph.blocks.3"],
  ]);
  const current = await f.f.getFlow(f.flow.id);
  assert(current.ok);
  expect(current.value.revision).toBe(f.flow.revision);
});

it("a Flow input connected to a Wait saves as a readiness issue and blocks Start", async (c) => {
  // Arrange
  const f = await prepared(c);
  const saved = await f.f.updateFlow(f.flow.id, {
    name: f.flow.name,
    expectedRevision: f.flow.revision,
    graph: {
      flowInput: flowInput("delay"),
      blocks: [
        waitStep("delay", "Delay", { amount: 5, unit: "minutes" }),
        agentBlock("worker", "Worker", f.agent.id),
      ],
      connections: [connection("delay", "output", "worker")],
    },
  });
  assert(saved.ok);

  // Act
  const started = await f.f.startRun(f.input);

  // Assert
  assert(!started.ok);
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["flow_input_wait", "graph.flowInput.targetBlockIds.0"],
  ]);
  expect(started.error.issues).toStrictEqual(saved.value.readiness.issues);
  expect(await f.f.listRuns(f.project.id)).toStrictEqual({ ok: true, value: [] });
});

import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { readFlowAfterRestart, waitDraft } from "./support/domain-setup.ts";
import {
  agentBlock,
  connection,
  flowInput,
  humanStep,
  WAIT_OUTPUT,
  waitBlock,
} from "./support/scenarios.ts";

it("a one-minute Wait between an Agent and a Human step saves ready and reads back after restart", async (c) => {
  // Arrange
  const draft = await waitDraft(c);
  const saved = await draft.save(draft.pause({ amount: 1, unit: "minutes" }));
  assert(saved.ok);
  await draft.factory.close();

  // Act
  const recovered = await readFlowAfterRestart(draft.harness, draft.flowId);

  // Assert
  expect(saved.value.readiness).toStrictEqual({ ready: true, issues: [] });
  expect(saved.value.graph.blocks[1]).toStrictEqual({
    id: "pause",
    kind: "wait",
    name: "Cool down",
    duration: { amount: 1, unit: "minutes" },
    position: { x: 400, y: 0 },
  });
  expect(recovered).toStrictEqual(saved);
});

it("a Wait of 168 hours is ready, as 7 days is", async (c) => {
  // Arrange
  const draft = await waitDraft(c);

  // Act
  const saved = await draft.save(draft.pause({ amount: 168, unit: "hours" }));

  // Assert
  assert(saved.ok);
  expect(saved.value.readiness.ready).toBe(true);
});

it("a Wait one minute longer than 7 days saves but cannot run", async (c) => {
  // Arrange
  const draft = await waitDraft(c);

  // Act
  const saved = await draft.save(draft.pause({ amount: 10_081, unit: "minutes" }));

  // Assert
  assert(saved.ok);
  expect(saved.value.revision).toBe(2);
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["wait_duration_range", "graph.blocks.1.duration"],
  ]);
});

it("a Wait without a duration saves but cannot run", async (c) => {
  // Arrange
  const draft = await waitDraft(c);

  // Act
  const saved = await draft.save(draft.pause(null));

  // Assert
  assert(saved.ok);
  expect(saved.value.graph.blocks[1]).toMatchObject({ kind: "wait", duration: null });
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["wait_duration_required", "graph.blocks.1.duration"],
  ]);
});

it("a fractional Wait amount is rejected and appends no revision", async (c) => {
  // Arrange
  const draft = await waitDraft(c);

  // Act
  const result = await draft.save(draft.pause({ amount: 1.5, unit: "hours" }));

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["invalid_wait_duration", "graph.blocks.1.duration"],
  ]);
  const flow = await draft.factory.getFlow(draft.flowId);
  assert(flow.ok);
  expect(flow.value.revision).toBe(1);
});

it("a Wait in weeks is rejected as an unknown unit", async (c) => {
  // Arrange
  const draft = await waitDraft(c);
  const weeks = { amount: 1, unit: "weeks" } as unknown as { amount: number; unit: "days" };

  // Act
  const result = await draft.save(draft.pause(weeks));

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => issue.code)).toStrictEqual(["invalid_wait_duration"]);
});

it("a Wait carrying an Agent reference is rejected", async (c) => {
  // Arrange
  const draft = await waitDraft(c);
  const withAgent = { ...draft.pause({ amount: 5, unit: "minutes" }), agentId: "coder-agent" };

  // Act
  const result = await draft.save(withAgent);

  // Assert
  assert(!result.ok);
  expect(result.error.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["block_overrides_forbidden", "graph.blocks.1"],
  ]);
});

it("a Flow input connected to a Wait saves but cannot run", async (c) => {
  // Arrange
  const draft = await waitDraft(c);

  // Act
  const saved = await draft.save(draft.pause({ amount: 5, unit: "minutes" }), ["coder", "pause"]);

  // Assert
  assert(saved.ok);
  expect(saved.value.graph.flowInput.targetBlockIds).toStrictEqual(["coder", "pause"]);
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["flow_input_wait", "graph.flowInput.targetBlockIds.1"],
  ]);
});

it("an unconnected Wait saves but cannot run", async (c) => {
  // Arrange
  const draft = await waitDraft(c);
  const created = await draft.factory.getFlow(draft.flowId);
  assert(created.ok);

  // Act
  const saved = await draft.factory.updateFlow(draft.flowId, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: created.value.workspace,
    graph: {
      flowInput: flowInput("coder"),
      blocks: [
        agentBlock("coder", "Coder", draft.agent.id),
        waitBlock("pause", "Cool down", { amount: 5, unit: "minutes" }),
      ],
      connections: [],
    },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["unreachable_block", "graph.blocks.1"],
  ]);
});

it("Start refuses a saved Flow whose input targets a Wait and creates no Run", async (c) => {
  // Arrange
  const { f, flow, agent, input, project } = await prepared(c);
  const saved = await f.updateFlow(flow.id, {
    name: flow.name,
    expectedRevision: flow.revision,
    workspace: flow.workspace,
    graph: {
      flowInput: flowInput("worker", "pause"),
      blocks: [
        agentBlock("worker", "Entry worker", agent.id),
        waitBlock("pause", "Cool down", { amount: 5, unit: "minutes" }),
        humanStep("review", "Review"),
      ],
      connections: [connection("pause", WAIT_OUTPUT, "review")],
    },
  });
  assert(saved.ok);

  // Act
  const started = await f.startRun(input);

  // Assert
  assert(!started.ok);
  expect(started.error.issues.map((issue) => issue.code)).toStrictEqual(["flow_input_wait"]);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
});

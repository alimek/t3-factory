import { assert, expect, it } from "@effect/vitest";
import { prepared, preparedSnapshotRun } from "./support/prepared-runner.ts";
import { interruptRunConversation } from "./support/run-worker.ts";

it("Run again uses the captured graph and Agent settings after their definitions change", async (c) => {
  // Arrange
  const { f, input, flow, agent } = await prepared(c);
  const source = await f.startRun(input);
  assert(source.ok);
  const agentUpdate = await f.updateAgent(agent.id, {
    ...agent,
    prompt: "Different instructions",
    execution: { ...agent.execution, modelOptions: [] },
    expectedRevision: agent.revision,
  });
  assert(agentUpdate.ok);
  expect(agentUpdate.value.prompt).toBe("Different instructions");
  const flowUpdate = await f.updateFlow(flow.id, {
    ...flow,
    name: "Changed flow",
    expectedRevision: flow.revision,
  });
  assert(flowUpdate.ok);
  expect(flowUpdate.value.name).toBe("Changed flow");

  // Act
  const repeated = await f.startRun({
    requestId: "snapshot-rerun",
    projectId: input.projectId,
    sourceRunId: source.value.id,
    input: "A different task",
  });

  // Assert
  assert(repeated.ok);
  expect(repeated.value.id).not.toBe(source.value.id);
  expect(repeated.value.snapshot).toStrictEqual(source.value.snapshot);
  expect(repeated.value.input).toBe("A different task");
});

it("Run again creates a new Run from a deleted Flow snapshot", async (c) => {
  // Arrange
  const { f, t3, input, flow } = await prepared(c);
  const source = await f.startRun(input);
  assert(source.ok);
  await f.reconcileRuns();
  assert((await f.stopRun(source.value.id)).ok);
  interruptRunConversation(t3);
  await f.reconcileRuns();
  await f.reconcileRuns();
  assert((await f.removeFlow(flow.id)).ok);

  // Act
  const repeated = await f.startRun({
    requestId: "deleted-source",
    projectId: input.projectId,
    sourceRunId: source.value.id,
    input: input.input,
    taskId: source.value.task.id,
  });

  // Assert
  assert(repeated.ok);
  expect(repeated.value.snapshot).toStrictEqual(source.value.snapshot);
  expect(repeated.value.task.id).toBe(source.value.task.id);
  const original = await f.getRun(source.value.id);
  assert(original.ok);
  expect(original.value.outcome).toBe("stopped");
});

it("Run again rejects captured model settings that are no longer available", async (c) => {
  // Arrange
  const { f, t3, snapshotInput } = await preparedSnapshotRun(c);
  t3.controlledProviders.splice(0);

  // Act
  const rejected = await f.startRun(snapshotInput);

  // Assert
  assert(!rejected.ok);
  expect(rejected.error.code).toBe("validation");
  expect(rejected.error.message).toMatch(/readiness/);
});

it("a snapshot Start request key cannot be reused with another source Run", async (c) => {
  // Arrange
  const { f, snapshotInput } = await preparedSnapshotRun(c);
  const first = await f.startRun(snapshotInput);
  assert(first.ok);

  // Act
  const rejected = await f.startRun({ ...snapshotInput, sourceRunId: first.value.id });

  // Assert
  assert(!rejected.ok);
  expect(rejected.error.code).toBe("conflict");
});

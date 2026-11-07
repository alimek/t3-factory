import { assert, expect, it } from "@effect/vitest";
import { sampleAgentInput } from "./support/domain-setup.ts";
import { prepared } from "./support/prepared-runner.ts";

it("removing an unused Agent deletes the definition", async (c) => {
  // Arrange
  const { f } = await prepared(c);
  const saved = await f.createAgent(sampleAgentInput());
  assert(saved.ok);

  // Act
  const removed = await f.removeAgent(saved.value.id);

  // Assert
  assert(removed.ok);
  const missing = await f.getAgent(saved.value.id);
  assert(!missing.ok);
  expect(missing.error.code).toBe("not_found");
});

it("removing an Agent referenced by a saved Flow is rejected and keeps the definition", async (c) => {
  // Arrange
  const { f, agent } = await prepared(c);

  // Act
  const removed = await f.removeAgent(agent.id);

  // Assert
  assert(!removed.ok);
  expect(removed.error.code).toBe("conflict");
  expect(removed.error.message).toMatch(/saved Flows/i);
  assert((await f.getAgent(agent.id)).ok);
});

it("removing an Agent after its Flow was removed preserves the Run definitions", async (c) => {
  // Arrange
  const { f, input, flow, agent } = await prepared(c);
  const started = await f.startRun(input);
  assert(started.ok);
  assert((await f.removeFlow(flow.id)).ok);

  // Act
  const removed = await f.removeAgent(agent.id);

  // Assert
  assert(removed.ok);
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.definitions.agents.some((item) => item.id === agent.id)).toBe(true);
  assert(!(await f.getAgent(agent.id)).ok);
});

it("removing a Flow preserves its active Run definitions and shared Agent", async (c) => {
  // Arrange
  const { f, input, flow, agent } = await prepared(c);
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();

  // Act
  const removed = await f.removeFlow(flow.id);

  // Assert
  assert(removed.ok);
  const missing = await f.getFlow(flow.id);
  assert(!missing.ok);
  expect(missing.error.code).toBe("not_found");
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.closedAt).toBe(null);
  expect(run.value.stopRequestedAt).toBe(null);
  expect(run.value.definitions).toStrictEqual(started.value.definitions);
  assert((await f.getAgent(agent.id)).ok);
});

it("a removed Flow rejects saves without being recreated and removing it again succeeds", async (c) => {
  // Arrange
  const { f, flow } = await prepared(c);
  assert((await f.removeFlow(flow.id)).ok);

  // Act
  const saved = await f.updateFlow(flow.id, { ...flow, expectedRevision: flow.revision });
  const removedAgain = await f.removeFlow(flow.id);

  // Assert
  assert(!saved.ok);
  expect(saved.error.code).toBe("not_found");
  expect(removedAgain).toStrictEqual({ ok: true, value: undefined });
  expect(await f.listFlows()).toStrictEqual({ ok: true, value: [] });
});

it("starting a removed Flow is rejected without creating a Run", async (c) => {
  // Arrange
  const { f, input, flow } = await prepared(c);
  assert((await f.removeFlow(flow.id)).ok);

  // Act
  const started = await f.startRun(input);

  // Assert
  assert(!started.ok);
  expect(started.error.code).toBe("not_found");
  expect(await f.listRunNavigation()).toStrictEqual({ ok: true, value: [] });
});

it("a removed Agent rejects saves, leaves the catalog and removing it again succeeds", async (c) => {
  // Arrange
  const { f } = await prepared(c);
  const saved = await f.createAgent(sampleAgentInput("Retired"));
  assert(saved.ok);
  assert((await f.removeAgent(saved.value.id)).ok);

  // Act
  const edited = await f.updateAgent(saved.value.id, {
    ...sampleAgentInput("Revived"),
    expectedRevision: saved.value.revision,
  });
  const duplicated = await f.duplicateAgent(saved.value.id, {});
  const removedAgain = await f.removeAgent(saved.value.id);

  // Assert
  assert(!edited.ok);
  expect(edited.error.code).toBe("not_found");
  assert(!duplicated.ok);
  expect(duplicated.error.code).toBe("not_found");
  expect(removedAgain).toStrictEqual({ ok: true, value: undefined });
  const listed = await f.listAgents();
  assert(listed.ok);
  expect(listed.value.some((agent) => agent.id === saved.value.id)).toBe(false);
});

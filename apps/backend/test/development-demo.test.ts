import { assert, expect, it } from "@effect/vitest";
import { restoredDevelopmentDemo } from "./support/development-demo.ts";

it("restored demo treats verified running work as normal progress and preserves its hierarchy and user edits", async (c) => {
  // Arrange
  const { f, before, edited, projectId, count } = await restoredDevelopmentDemo(c);

  // Act
  const reconciled = await f.reconcileRuns();

  // Assert
  assert(reconciled.ok);
  const after = await f.getRun(before.id);
  const flow = await f.getFlow(edited.id);
  const runs = await f.listRuns(projectId);
  assert(after.ok);
  assert(flow.ok);
  assert(runs.ok);
  expect(after.value.definitions).toStrictEqual(before.definitions);
  expect(after.value.threadBindings).toStrictEqual(before.threadBindings);
  expect(after.value.runCoordinator).toBeNull();
  expect(after.value.executions.map((e) => [e.executionId, e.engineStatus])).toStrictEqual(
    before.executions.map((e) => [e.executionId, e.engineStatus]),
  );
  expect(after.value.outcome).toBeNull();
  expect(after.value.blocks.some((block) => block.threadId !== null)).toBe(true);
  expect(after.value.blocks[0]).toMatchObject({
    state: "working",
    engineStatus: "completed",
    problem: null,
  });
  expect(after.value.threadBindings).toContainEqual(
    expect.objectContaining({ role: "descendant" }),
  );
  expect(
    after.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
  expect(flow.value).toStrictEqual(edited);
  expect(runs.value).toHaveLength(count);
});

import { assert, expect, it } from "@effect/vitest";
import { restoredDevelopmentDemo } from "./support/development-demo.ts";

it("restored demo keeps a worker waiting on its running subagents as normal progress and preserves user edits", async (c) => {
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
  expect(after.value.lifecycle).toBe("active");
  expect(after.value.blocks.some((block) => block.threadId !== null)).toBe(true);
  expect(after.value.blocks[0]).toMatchObject({
    state: "working",
    engineStatus: "completed",
    problem: null,
  });
  expect(
    after.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
  expect(flow.value).toStrictEqual(edited);
  expect(runs.value).toHaveLength(count);
});

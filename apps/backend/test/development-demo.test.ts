import { assert, expect, it } from "@effect/vitest";
import { restoredDevelopmentDemo } from "./support/development-demo.ts";

it("restored demo treats verified running work as normal progress and preserves its hierarchy and user edits", async (c) => {
  // Arrange
  const { f, t3, before, edited, projectId, count } = await restoredDevelopmentDemo(c);

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
  expect(after.value.snapshot).toStrictEqual(before.snapshot);
  expect(after.value.threadBindings).toStrictEqual(before.threadBindings);
  expect(after.value.runCoordinator?.threadId).toBe(before.runCoordinator?.threadId);
  expect(after.value.runCoordinator?.problem).toBeNull();
  expect(after.value.executions.map((e) => [e.executionId, e.engineStatus])).toStrictEqual(
    before.executions.map((e) => [e.executionId, e.engineStatus]),
  );
  expect(after.value.outcome).toBeNull();
  assert(after.value.runCoordinator?.threadId);
  assert(after.value.runCoordinator.executionId);
  const native = await t3.readDelegatedSettlement(
    { endpoint: "demo" },
    after.value.runCoordinator.threadId,
    after.value.runCoordinator.executionId,
  );
  expect(native.state).toBe("pending");
  expect(native.resultRun).toBeNull();
  expect(flow.value).toStrictEqual(edited);
  expect(runs.value).toHaveLength(count);
});

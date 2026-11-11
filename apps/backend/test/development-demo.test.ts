import { assert, expect, it } from "@effect/vitest";
import { restoredDevelopmentDemo } from "./support/development-demo.ts";
import { factoryHarness } from "./support/factory.ts";
import { PersistentT3 } from "../../../scripts/dev/persistent-t3.ts";

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

it("a Stop the demo simulator holds stays held after the simulator restarts", async (c) => {
  // Arrange
  const { processHome } = await factoryHarness(c);
  const threadId = "held-stop-thread";
  const runId = `run:thread:${threadId}:ordinal:1`;
  const t3 = new PersistentT3(processHome, false);
  t3.executionObservations.set(threadId, {
    threadId,
    projectId: "demo-project",
    workspaceRoot: processHome,
    link: `t3://threads/${threadId}`,
    activeRunId: runId,
    latestRunId: runId,
    pendingRequestCount: 0,
    recentRuns: [{ runId, status: "running", ordinal: 1 }],
  });
  t3.holdStops([threadId]);
  const restarted = new PersistentT3(processHome, true);

  // Act
  await restarted.stopThread({ endpoint: "" }, { threadId, clientRequestId: "settle-stop" });

  // Assert
  expect(restarted.executionObservations.get(threadId)?.activeRunId).toBe(runId);
});

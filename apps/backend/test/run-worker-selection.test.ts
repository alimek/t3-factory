import { assert, expect, it } from "@effect/vitest";
import { reportedWorker } from "./support/run-worker.ts";

it("restoring the thread model cannot release work whose exact execution selection contradicts the captured Agent", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  const [key, launch] = [...f.t3.launches.entries()][0]!;
  f.t3.launches.set(key, {
    ...launch,
    payload: {
      ...launch.payload,
      modelSelection: {
        ...launch.payload.modelSelection,
        instanceId: "other-provider",
        model: "other-model",
      },
    },
  });

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(run.value.activations).toHaveLength(1);
  expect(run.value.closedAt).toBeNull();
});

it("native work issued after a worker final holds release and preserves the accepted result", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  const activity = f.t3.delegationActivities.get("thread-1")!;
  f.t3.delegationActivities.set("thread-1", {
    ...activity,
    commands: [
      {
        itemId: "after-final-launch",
        parentRunId: "execution-1",
        fingerprint: "after-final",
        envelope: JSON.stringify({ toolName: "t3-code.t3_thread_launch" }),
        references: [],
      },
    ],
  });

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toHaveLength(1);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(run.value.activations).toHaveLength(1);
});

import { assert, expect, it } from "@effect/vitest";
import {
  revisitReportingWorker,
  reportedWorker,
  workerNativeReply,
  workerFinal,
} from "./support/run-worker.ts";

it("restoring the thread model cannot release work whose exact execution selection contradicts the captured Agent", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  const child = f.t3.childEvidence.get("thread-2")!;
  f.t3.childEvidence.set("thread-2", {
    ...child,
    execution: { ...child.execution!, providerInstanceId: "other-provider", model: "other-model" },
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

it("a native worker answer on a substituted thread model cannot freeze an immutable final", async (c) => {
  // Arrange
  const f = await workerNativeReply(c);
  const key = JSON.stringify(["thread-2", "answer-execution"]);
  const child = f.t3.childEvidence.get(key)!;
  f.t3.childEvidence.set(key, {
    ...child,
    thread: { ...child.thread!, model: "other-model" },
  });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ASSESSMENT_UNVERIFIED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
  expect(run.value.closedAt).toBeNull();
});

it("a revisit final with independently verified captured settings belongs to its own activation", async (c) => {
  // Arrange
  const f = await revisitReportingWorker(c);

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toHaveLength(2);
  expect(run.value.reports[1]?.activationId).toBe(run.value.activations[1]?.id);
});

it("native work issued after a worker final holds release and preserves the accepted result", async (c) => {
  // Arrange
  const f = await reportedWorker(c);
  const activity = f.t3.delegationActivities.get("thread-2")!;
  f.t3.delegationActivities.set("thread-2", {
    ...activity,
    commands: [
      {
        itemId: "after-final-launch",
        parentRunId: "execution-2",
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
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({ kind: "report-problem", settledAt: null }),
  );
});

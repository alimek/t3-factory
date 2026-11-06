import { workerRecoveryTurn } from "./support/run-worker-recovery.ts";
import { assert, expect, it } from "@effect/vitest";
import {
  workerWithOwnedControl,
  reportedControlledWorker,
  workerWithUnknownControl,
  workerWithLateControl,
} from "./support/run-worker-commands.ts";
import { workerFinal, finishWorker } from "./support/run-worker.ts";

it("a verified pre-final control command permits finished closure once the owned tree is freshly quiet", async (c) => {
  // Arrange
  const f = await reportedControlledWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBe("finished");
  expect(run.value.reports[0]?.completionEligibleAt).not.toBeNull();
});

it("a retained verified control receipt does not poison a later explicit worker reporting recovery", async (c) => {
  // Arrange
  const f = await workerWithOwnedControl(c);
  finishWorker(f);
  assert((await f.f.reconcileRuns()).ok);
  const before = await f.f.getRun(f.runId);
  assert(before.ok);
  const missing = before.value.attention.find((a) => a.kind === "missing-report" && !a.settledAt)!;
  assert(missing);
  const recovery = await workerRecoveryTurn(f, missing.id);

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports[0]?.executionId).toBe(recovery.executionId);
  expect(run.value.reports[0]?.activationId).toBe(run.value.activations[0]?.id);
});

it("an unverified native control target holds a worker final with a specific visible problem", async (c) => {
  // Arrange
  const f = await workerWithUnknownControl(c);

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).not.toBe("ACCEPTED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toStrictEqual([]);
  expect(run.value.blocks[0]?.problem).toBe(
    "Worker native command target or result is unverified.",
  );
});

it("a new native control after an accepted worker final holds release without replacing the result", async (c) => {
  // Arrange
  const f = await workerWithLateControl(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.reports).toHaveLength(1);
  expect(run.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(run.value.blocks[0]?.problem).toBe(
    "Unauthorized post-checkpoint work requires attention.",
  );
});

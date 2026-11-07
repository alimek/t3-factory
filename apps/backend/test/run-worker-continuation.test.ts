import { assert, expect, it } from "@effect/vitest";
import {
  continuedWorker,
  continuedDelegation,
  delegatingWorker,
} from "./support/run-worker-continuation.ts";
import { workerFinal } from "./support/run-worker.ts";
import { finishNativeTurn } from "../../../scripts/dev/native-simulation.ts";

it("a worker yielding to an active child stays working without a missing-report Problem", async (c) => {
  // Arrange
  const f = await delegatingWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "working",
    engineStatus: "completed",
    problem: null,
  });
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
  expect(run.value.closedAt).toBeNull();
});

it("a completed child does not create a missing-report Problem while T3 still has a continuation pending", async (c) => {
  // Arrange
  const f = await delegatingWorker(c);
  finishNativeTurn(f.t3, "thread-3", "execution-3");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ state: "working", problem: null });
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
});

it("a native completion notification lets the resumed worker finish its activation after restart", async (c) => {
  // Arrange
  const f = await continuedWorker(c);
  await f.f.close();
  const factory = await f.h.open({ t3: f.t3 });

  // Act
  const result = await factory.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const run = await factory.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations).toHaveLength(1);
  expect(run.value.reports).toMatchObject([
    { executionId: "continuation-execution", activationId: run.value.activations[0]?.id },
  ]);
  expect(
    run.value.attention.filter((a) => a.kind === "missing-report" && !a.settledAt),
  ).toStrictEqual([]);
});

it("an agent-authored notification cannot acquire the worker activation", async (c) => {
  // Arrange
  const f = await continuedWorker(c, { createdBy: "agent", creationSource: "mcp" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});

it("a delegated workflow closes after its resumed worker reports and its whole tree completes", async (c) => {
  // Arrange
  const f = await continuedDelegation(c);
  assert((await f.f.runtime.submit(workerFinal())).code === "ACCEPTED");
  finishNativeTurn(f.t3, "thread-1", "continuation-execution");

  // Act
  await f.f.reconcileRuns();

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.outcome).toBe("finished");
  expect(run.value.reports).toMatchObject([
    { executionId: "continuation-execution", completionEligibleAt: expect.any(String) },
  ]);
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});

it("a notification forwarded from another thread cannot acquire the worker activation", async (c) => {
  // Arrange
  const f = await continuedWorker(c, { senderThreadId: "foreign-thread" });

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
});

it("a background completion notification cannot answer an outstanding worker question", async (c) => {
  // Arrange
  const f = await continuedWorker(c, {}, true);

  // Act
  const result = await f.f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_ACTIVATION");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({ kind: "conversation-waiting", settledAt: null }),
  );
  expect(run.value.reports).toStrictEqual([]);
});

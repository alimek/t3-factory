import { closedRoot, rootWithSdk } from "./support/run-root-settlement.ts";
import { assert, expect, it } from "@effect/vitest";
import { finishedWorker } from "./support/run-worker.ts";

it("native organization capability absence cannot delay Finished business closure", async (c) => {
  // Arrange
  const { f, t3, runId } = await finishedWorker(c);
  t3.settleSupported = false;

  // Act
  await f.reconcileRuns();

  // Assert
  const detail = await f.getRun(runId);
  assert(detail.ok);
  expect(detail.value.outcome).toBe("finished");
  expect(t3.settlements).toStrictEqual([]);
});

it("Finished closure does not organize a Block worker as a Run conversation", async (c) => {
  // Arrange
  const { f, h, t3, runId, before } = await closedRoot(c);
  t3.settleSupported = true;
  await f.reconcileRuns();
  await f.close();

  // Act
  const reopened = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  expect(t3.settlements).toStrictEqual([]);
  expect(await reopened.getRun(runId)).toStrictEqual(before);
});

it("Finished closure does not call native organize on the worker", async (c) => {
  // Arrange
  const { f, runId, seen, before } = await rootWithSdk(c);

  // Act
  await f.reconcileRuns();

  // Assert
  expect(seen).toStrictEqual([]);
  expect(await f.getRun(runId)).toStrictEqual(before);
});

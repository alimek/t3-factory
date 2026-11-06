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

it("lost native organization acknowledgement never re-hides a manually reopened primary on restart", async (c) => {
  // Arrange
  const { f, h, t3, runId, before } = await closedRoot(c);
  const settle = t3.settleThread.bind(t3);
  t3.settleThread = async (...args) => {
    await settle(...args);
    throw Error("Lost acknowledgement");
  };
  t3.settleSupported = true;
  await f.reconcileRuns();
  await f.close();
  t3.settledThreads.delete("thread-1");

  // Act
  const reopened = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  expect(t3.settlements).toStrictEqual([{ threadId: "thread-1" }]);
  expect(t3.settledThreads.has("thread-1")).toBe(false);
  expect(await reopened.getRun(runId)).toStrictEqual(before);
});

it("primary native organize acceptance uses the actual SDK after Finished closure", async (c) => {
  // Arrange
  const { f, runId, seen, before } = await rootWithSdk(c);

  // Act
  await f.reconcileRuns();

  // Assert
  expect(seen).toStrictEqual([{ action: "settle", threadId: "thread-1" }]);
  expect(await f.getRun(runId)).toStrictEqual(before);
});

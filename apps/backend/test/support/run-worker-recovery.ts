import { assert, type TestContext } from "@effect/vitest";
import { missingWorkerReport, directWorker, idleWorkingWorker } from "./run-worker.ts";
import { allTurnsEnd, finishedReport, report, turnBegins, workingReport } from "./scenarios.ts";

/** Request report on the Block; its queued send then runs as a new turn of the worker thread. */
async function workerRecoveryTurn(f: Awaited<ReturnType<typeof directWorker>>, blockId: string) {
  assert((await f.f.requestReport(f.runId, { blockId })).ok);
  const executionId = [...f.t3.sends.values()][0]!.reference.runId;
  return { ...f, worker: turnBegins(f.world, f.worker, executionId), executionId };
}

/** The Request report turn reports the Block's result and its run completes. */
async function reportedRecoveryTurn<F extends Awaited<ReturnType<typeof workerRecoveryTurn>>>(
  f: F,
) {
  assert((await report(f.world, f.worker, finishedReport())) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);
  await f.f.reconcileRuns();
  return f;
}

export async function completedWorkerRecovery(c: TestContext) {
  const f = await missingWorkerReport(c);
  return reportedRecoveryTurn(await workerRecoveryTurn(f, f.missing.blockId));
}

/** The Request report turn finds the discussion unfinished, reports working and finishes in T3. */
export async function unfinishedWorkerRecovery(c: TestContext) {
  const missing = await missingWorkerReport(c);
  const f = await workerRecoveryTurn(missing, missing.missing.blockId);
  assert((await report(f.world, f.worker, workingReport())) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);
  return f;
}

/** Request report on a worker idle in working, answered with the Block's result. */
export async function completedWorkingRecovery(c: TestContext) {
  return reportedRecoveryTurn(await workerRecoveryTurn(await idleWorkingWorker(c), "worker"));
}

export async function rejectedWorkerReport(c: TestContext) {
  const f = await directWorker(c, true, "");
  assert((await report(f.world, f.worker, { to: "finished", exit: "unknown" })) === "INVALID_EXIT");
  return f;
}

export async function recoveringRejectedWorker(c: TestContext) {
  const f = await missingWorkerReport(c, await rejectedWorkerReport(c));
  return workerRecoveryTurn(f, f.missing.blockId);
}

import { assert, type TestContext } from "@effect/vitest";
import {
  missingWorkerReport,
  workerFinal,
  directWorker,
  finishWorker,
  idleWorkingWorker,
  workerWorking,
} from "./run-worker.ts";

async function workerRecoveryTurn(f: Awaited<ReturnType<typeof directWorker>>, blockId: string) {
  assert((await f.f.requestReport(f.runId, { blockId })).ok);
  const sent = [...f.t3.sends.values()][0]!;
  const executionId = sent.reference.runId;
  f.t3.sends.set(sent.payload.clientRequestId, {
    ...sent,
    reference: { ...sent.reference, status: "running" },
  });
  const prior = f.t3.executionObservations.get("thread-1")!;
  f.t3.executionObservations.set("thread-1", {
    ...prior,
    activeRunId: executionId,
    latestRunId: executionId,
    recentRuns: [...prior.recentRuns, { runId: executionId, status: "running", ordinal: 2 }],
  });
  return { ...f, executionId, sent };
}

/** The Request report turn reports the Block's result and its run completes. */
async function reportedRecoveryTurn<F extends Awaited<ReturnType<typeof workerRecoveryTurn>>>(
  f: F,
) {
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  completeRecoveryTurn(f);
  await f.f.reconcileRuns();
  return f;
}

function completeRecoveryTurn(f: Awaited<ReturnType<typeof workerRecoveryTurn>>) {
  f.t3.sends.set(f.sent.payload.clientRequestId, {
    ...f.sent,
    reference: { ...f.sent.reference, status: "completed" },
  });
  finishWorker(f);
}

export async function completedWorkerRecovery(c: TestContext) {
  const f = await missingWorkerReport(c);
  return reportedRecoveryTurn(await workerRecoveryTurn(f, f.missing.blockId));
}

/** The Request report turn finds the discussion unfinished, reports working and finishes in T3. */
export async function unfinishedWorkerRecovery(c: TestContext) {
  const missing = await missingWorkerReport(c);
  const f = await workerRecoveryTurn(missing, missing.missing.blockId);
  assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
  completeRecoveryTurn(f);
  return f;
}

/** Request report on a worker idle in working, answered with the Block's result. */
export async function completedWorkingRecovery(c: TestContext) {
  return reportedRecoveryTurn(await workerRecoveryTurn(await idleWorkingWorker(c), "worker"));
}

export async function rejectedWorkerReport(c: TestContext) {
  const f = await directWorker(c, true, "");
  assert(
    (
      await f.f.runtime.submit({
        arguments: { blockId: f.blockId, to: "finished", exit: "unknown" },
      })
    ).code === "INVALID_EXIT",
  );
  return f;
}

export async function recoveringRejectedWorker(c: TestContext) {
  const f = await missingWorkerReport(c, await rejectedWorkerReport(c));
  return workerRecoveryTurn(f, f.missing.blockId);
}

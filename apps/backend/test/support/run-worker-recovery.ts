import { assert, type TestContext } from "@effect/vitest";
import { missingWorkerReport, workerFinal, directWorker } from "./run-worker.ts";

export async function workerRecoveryTurn(
  f: Awaited<ReturnType<typeof directWorker>>,
  attentionId: string,
) {
  assert((await f.f.requestReport(attentionId)).ok);
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

export async function completedWorkerRecovery(c: TestContext) {
  const f = await missingWorkerReport(c);
  const { executionId, sent } = await workerRecoveryTurn(f, f.missing.id);
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  f.t3.sends.set(sent.payload.clientRequestId, {
    ...sent,
    reference: { ...sent.reference, status: "completed" },
  });
  const active = f.t3.executionObservations.get("thread-1")!;
  f.t3.executionObservations.set("thread-1", {
    ...active,
    activeRunId: null,
    recentRuns: active.recentRuns.map((r) => ({ ...r, status: "completed" })),
  });
  f.t3.delegatedSettlements.set(JSON.stringify(["thread-1", executionId]), {
    threadId: "thread-1",
    runId: executionId,
    state: "settled",
    status: "completed",
    resultRun: { runId: executionId, status: "completed" },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
  await f.f.reconcileRuns();
  return { ...f, executionId };
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
  return workerRecoveryTurn(f, f.missing.id);
}

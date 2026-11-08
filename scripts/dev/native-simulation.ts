import type { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";

/** Simulated T3 answer to `t3_thread_wait` for one run with its delegated work. */
export function answerWait(
  t3: ControlledT3,
  threadId: string,
  runId: string,
  state: "settled" | "pending",
  status: string,
) {
  t3.delegatedSettlements.set(JSON.stringify([threadId, runId]), {
    threadId,
    runId,
    state,
    status,
  });
}

/** Simulated external engine facts, never Factory bindings or Run projections. */
export function beginNativeTurn(t3: ControlledT3, threadId: string, runId: string) {
  answerWait(t3, threadId, runId, "pending", "running");
  const prior = t3.executionObservations.get(threadId);
  if (!prior) throw Error(`Unknown simulated thread ${threadId}`);
  t3.executionObservations.set(threadId, {
    ...prior,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: [
      ...prior.recentRuns,
      {
        runId,
        status: "running",
        ordinal: 1 + Math.max(0, ...prior.recentRuns.map((r) => r.ordinal ?? 0)),
        startedAt: new Date().toISOString(),
      },
    ],
  });
}

export function finishNativeTurn(
  t3: ControlledT3,
  threadId: string,
  runId: string,
  status = "completed",
) {
  const prior = t3.executionObservations.get(threadId);
  if (!prior) throw Error(`Unknown simulated thread ${threadId}`);
  t3.executionObservations.set(threadId, {
    ...prior,
    activeRunId: prior.activeRunId === runId ? null : prior.activeRunId,
    recentRuns: prior.recentRuns.map((r) =>
      r.runId === runId ? { ...r, status, completedAt: new Date().toISOString() } : r,
    ),
  });
  answerWait(t3, threadId, runId, "settled", status);
  for (const send of t3.sends.values())
    if (send.reference.runId === runId) send.reference = { ...send.reference, status };
}

export async function recordThread(t3: ControlledT3, threadId: string) {
  if (t3.executionObservations.has(threadId)) return;
  t3.executionObservations.set(threadId, await t3.readExecution({ endpoint: "demo" }, threadId));
}

/** A queued send starts once its thread is idle. */
function startIssuedTurn(t3: ControlledT3, threadId: string, runId: string) {
  const observation = t3.executionObservations.get(threadId);
  const execution = observation?.recentRuns.find((r) => r.runId === runId);
  if (!observation || execution?.status !== "queued" || observation.activeRunId) return;
  t3.executionObservations.set(threadId, {
    ...observation,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: observation.recentRuns.map((r) =>
      r.runId === runId ? { ...r, status: "running" } : r,
    ),
  });
  for (const send of t3.sends.values())
    if (send.reference.runId === runId)
      send.reference = { ...send.reference, status: "running", delivery: "started" };
}

export function advanceNative(t3: ControlledT3) {
  for (const { payload, reference } of t3.sends.values())
    startIssuedTurn(t3, payload.threadId, reference.runId);
}

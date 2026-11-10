import type { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";

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

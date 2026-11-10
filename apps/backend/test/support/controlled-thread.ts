import type { ControlledT3 } from "./controlled-t3.ts";

/*
 * Simulated worker-thread facts: what T3 shows about a thread and its runs, never Factory
 * bindings or Run projections. Shared by the scenario steps and the persistent simulator.
 */

function statedThread(t3: ControlledT3, threadId: string, fact: string) {
  const thread = t3.executionObservations.get(threadId);
  if (!thread) throw Error(`T3 fact "${fact}": thread ${threadId} has no stated observation.`);
  return thread;
}

/** T3's `t3_thread_wait` answer for one run of a thread with its delegated and background work. */
export function answerDelegatedWait(
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

/**
 * T3 shows a thread it launched, with its first turn running, as that thread's stated
 * observation; the later turn facts change it. A thread already stated keeps its facts.
 */
export async function recordLaunchedThread(t3: ControlledT3, threadId: string) {
  if (t3.executionObservations.has(threadId)) return;
  t3.executionObservations.set(threadId, await t3.readExecution({ endpoint: "" }, threadId));
}

/** A turn begins: run `runId` of the thread runs, and T3 answers its delegated wait as pending.
 * A send whose run this is shows it running. */
export function beginThreadRun(t3: ControlledT3, threadId: string, runId: string) {
  const prior = statedThread(t3, threadId, "turn begins");
  t3.executionObservations.set(threadId, {
    ...prior,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: [
      ...prior.recentRuns,
      {
        runId,
        status: "running",
        ordinal: 1 + Math.max(0, ...prior.recentRuns.map((run) => run.ordinal ?? 0)),
        startedAt: new Date().toISOString(),
      },
    ],
  });
  answerDelegatedWait(t3, threadId, runId, "pending", "running");
  for (const send of t3.sends.values())
    if (send.reference.runId === runId) send.reference = { ...send.reference, status: "running" };
}

/** A turn ends: run `runId` of the thread ends with `status`, and T3 answers its delegated wait
 * as settled. A send whose run this is shows the same status. */
export function endThreadRun(
  t3: ControlledT3,
  threadId: string,
  runId: string,
  status = "completed",
) {
  const prior = statedThread(t3, threadId, "turn ends");
  t3.executionObservations.set(threadId, {
    ...prior,
    activeRunId: prior.activeRunId === runId ? null : prior.activeRunId,
    recentRuns: prior.recentRuns.map((run) =>
      run.runId === runId ? { ...run, status, completedAt: new Date().toISOString() } : run,
    ),
  });
  answerDelegatedWait(t3, threadId, runId, "settled", status);
  for (const send of t3.sends.values())
    if (send.reference.runId === runId) send.reference = { ...send.reference, status };
}

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

type ThreadObservation = NonNullable<ReturnType<ControlledT3["executionObservations"]["get"]>>;
export type ThreadFacts = Partial<Pick<ThreadObservation, "repository" | "pendingRequestCount">>;

/** T3's read of the thread also shows `facts`: its repository, or pending native requests. */
export function recordThreadFacts(t3: ControlledT3, threadId: string, facts: ThreadFacts) {
  t3.executionObservations.set(threadId, {
    ...statedThread(t3, threadId, "thread facts"),
    ...facts,
  });
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

/** T3 starts a send it queued once the thread runs no turn: the send's queued run runs and the
 * send shows it running with its delivery started. Until then the send stays queued. */
export function startQueuedSend(t3: ControlledT3, threadId: string, runId: string) {
  const thread = t3.executionObservations.get(threadId);
  const queued = thread?.recentRuns.find((run) => run.runId === runId)?.status === "queued";
  if (!thread || !queued || thread.activeRunId) return;
  t3.executionObservations.set(threadId, {
    ...thread,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: thread.recentRuns.map((run) =>
      run.runId === runId ? { ...run, status: "running" } : run,
    ),
  });
  for (const send of t3.sends.values())
    if (send.reference.runId === runId)
      send.reference = { ...send.reference, status: "running", delivery: "started" };
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

/** Whenever T3 accepts a send to the thread, it shows the thread busy again: its latest turn
 * runs, with the send queued behind it. This is ControlledT3's own read of a launched thread whose
 * engine runs again once a send arrives, which the worktree review tests were written against. */
export function busyAgainOnSend(t3: ControlledT3, threadId: string) {
  const send = t3.sendMessage.bind(t3);
  t3.sendMessage = async (target, payload) => {
    const reference = await send(target, payload);
    if (payload.threadId !== threadId) return reference;
    const thread = statedThread(t3, threadId, "busy again on send");
    const latest = thread.latestRunId;
    const runs = thread.recentRuns.map(({ completedAt: _completedAt, ...run }, index) =>
      run.runId === latest ? { ...run, status: "running" } : thread.recentRuns[index]!,
    );
    t3.executionObservations.set(threadId, {
      ...thread,
      activeRunId: latest ?? null,
      recentRuns: runs.some((run) => run.runId === reference.runId)
        ? runs
        : [...runs, { runId: reference.runId, status: reference.status, ordinal: runs.length + 1 }],
    });
    return reference;
  };
}

const terminalStatuses = ["completed", "failed", "cancelled", "interrupted", "rolled_back"];

/** T3 carries out every thread Stop at once: each unfinished run of the stopped thread ends
 * interrupted, with its delegated work settled. Until then Stop is only acknowledged. */
export function stopsEndThreads(t3: ControlledT3) {
  const stop = t3.stopThread.bind(t3);
  t3.stopThread = async (target, payload) => {
    await stop(target, payload);
    const thread = statedThread(t3, payload.threadId, "Stop ends the thread");
    for (const run of thread.recentRuns)
      if (!terminalStatuses.includes(run.status))
        endThreadRun(t3, payload.threadId, run.runId, "interrupted");
  };
}

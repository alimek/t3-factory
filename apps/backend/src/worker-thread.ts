import type { ExecutionObservation, T3Adapter } from "./adapters/t3.ts";
import type { RunRow } from "./runner-types.ts";
import { inRunWorkspace } from "./run-workspace.ts";
import { runTarget } from "./runner-utils.ts";

type ThreadRun = Pick<
  RunRow,
  "endpoint" | "environment_id" | "t3_project_id" | "workspace_root" | "workspace"
>;

/** One Block's worker thread as T3 reports it now. */
export interface WorkerThread {
  readonly thread: ExecutionObservation;
  /** The active run, else the latest one; null before T3 shows any run of the thread. */
  readonly latest: ExecutionObservation["recentRuns"][number] | null;
  /** The shared "worker thread finished" rule; see {@link readWorkerThread}. */
  readonly finished: boolean;
}

/** A failed, cancelled, interrupted or rolled-back run is an execution failure of its Block. */
export const failedRun = (status: string | undefined) =>
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

/**
 * Factory trusts T3 to decide when a worker thread is finished. It is finished when the thread
 * read shows no active run and no pending native request, and `t3_thread_wait` for its latest
 * run (with its delegated and background work) answers a terminal status without timing out.
 * T3's `resultRun` is not consulted. Factory keeps no model of descendants, queues or
 * individual executions.
 */
export async function readWorkerThread(
  t3: T3Adapter,
  run: ThreadRun,
  threadId: string,
): Promise<WorkerThread> {
  const target = runTarget(run);
  const thread = await t3.readExecution(target, threadId);
  if (
    thread.threadId !== threadId ||
    thread.projectId !== run.t3_project_id ||
    !inRunWorkspace(run, thread.workspaceRoot)
  )
    throw Error("Worker thread scope changed.");
  const latestId = thread.activeRunId ?? thread.latestRunId ?? null;
  const latest = thread.recentRuns.find((r) => r.runId === latestId) ?? null;
  if (thread.activeRunId || thread.pendingRequestCount !== 0 || !latestId)
    return { thread, latest, finished: false };
  const settlement = await t3.readDelegatedSettlement(target, threadId, latestId);
  return { thread, latest, finished: settlement.state === "settled" };
}

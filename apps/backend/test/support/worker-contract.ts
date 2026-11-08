import type { TestContext } from "@effect/vitest";
import { workerActivity } from "../fixtures/t3-worker-activity.ts";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";
import { directWorker } from "./run-worker.ts";

/** Serve the reduced capture unchanged. */
export function capturedWorker(c: TestContext) {
  return authorizedLiveOAuth(c, { runtimeActivity: () => workerActivity });
}

/** T3's settled `t3_thread_wait` answer for the worker's waited run. */
export const settledAnswer = (runId: string): Record<string, unknown> => ({
  threadId: "thread-1",
  runId,
  status: "completed",
  timedOut: false,
  resultRun: { runId, status: "completed" },
});

/** The worker's thread reads and delegated waits cross the live HTTP adapter using captured
 * thread metadata; launches, sends and engine progress stay controlled. */
export async function wireWorker(c: TestContext, wait: (runId: string) => Record<string, unknown>) {
  const f = await directWorker(c);
  const threadId = "thread-1";
  const wire = await authorizedLiveOAuth(c, {
    runtimeActivity: () => {
      const observation = f.t3.executionObservations.get(threadId)!;
      return {
        ...workerActivity,
        thread: {
          ...workerActivity.thread,
          projectId: f.project.projectId,
          activeRunId: observation.activeRunId,
          latestRunId: observation.latestRunId,
          pendingRequestCount: observation.pendingRequestCount,
        },
        recentRuns: [...observation.recentRuns].reverse(),
        items: [],
      };
    },
    wait: (args) => wait(String(args.runId)),
  });
  const target = { endpoint: wire.endpoint };
  const readExecution = f.t3.readExecution.bind(f.t3);
  f.t3.readExecution = (t, id) =>
    id === threadId ? wire.adapter.readExecution(target, id) : readExecution(t, id);
  const readDelegatedSettlement = f.t3.readDelegatedSettlement.bind(f.t3);
  f.t3.readDelegatedSettlement = (t, id, runId) =>
    id === threadId
      ? wire.adapter.readDelegatedSettlement(target, id, runId)
      : readDelegatedSettlement(t, id, runId);
  return f;
}

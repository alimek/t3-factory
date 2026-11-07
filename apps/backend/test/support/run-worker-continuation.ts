import { assert, type TestContext } from "@effect/vitest";
import { directWorker, finishWorker, waitingWorker } from "./run-worker.ts";
import { nativeChild, supplyChild } from "./native-root-evidence.ts";
import { nativeDelegation } from "./native-delegation.ts";
import { bindThreadReportCaller } from "./lifecycle-setup.ts";
import type { RuntimeActivity } from "../../src/adapters/t3.ts";
import { finishNativeTurn } from "../../../../scripts/dev/native-simulation.ts";

/** The worker yields its turn while its accepted child still works. */
export async function delegatingWorker(c: TestContext) {
  const f = await directWorker(c, true, "");
  const invocation = nativeChild(nativeDelegation().input, "execution-1", 3, f.project.projectId);
  supplyChild(f.t3, invocation, f.project);
  const activity = f.t3.delegationActivities.get("thread-1")!;
  f.t3.delegationActivities.set("thread-1", { ...activity, invocations: [invocation] });
  finishWorker(f);
  f.t3.delegatedSettlements.set(JSON.stringify(["thread-1", "execution-1"]), {
    threadId: "thread-1",
    runId: "execution-1",
    state: "pending",
    status: "completed",
    resultRun: null,
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
  return f;
}

/** A native notification resumes the same unfinished worker with a new exact execution. */
export async function continuedWorker(
  c: TestContext,
  notification: Partial<RuntimeActivity["items"][number]> = {},
  needsReply = false,
) {
  const f = needsReply ? await waitingWorker(c) : await directWorker(c, true, "");
  finishWorker(f);
  assert((await f.f.reconcileRuns()).ok);
  resumeWorker(f, notification);
  return f;
}

export async function continuedDelegation(c: TestContext) {
  const f = await delegatingWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  finishNativeTurn(f.t3, "thread-3", "execution-3");
  resumeWorker(f);
  return f;
}

function resumeWorker(
  f: Awaited<ReturnType<typeof directWorker>>,
  notification: Partial<RuntimeActivity["items"][number]> = {},
) {
  const prior = f.t3.executionObservations.get("thread-1")!;
  f.t3.executionObservations.set("thread-1", {
    ...prior,
    activeRunId: "continuation-execution",
    latestRunId: "continuation-execution",
    recentRuns: [
      ...prior.recentRuns,
      { runId: "continuation-execution", status: "running", ordinal: 2 },
    ],
  });
  bindThreadReportCaller(
    f.t3,
    f.project.projectId,
    "thread-1",
    "continuation-execution",
    "worker-report",
  );
  f.t3.runtimeActivity = {
    ...f.t3.runtimeActivity,
    items: [
      ...f.t3.runtimeActivity.items,
      {
        itemId: "native-continuation",
        type: "notification",
        runId: "continuation-execution",
        text: "Delegated task finished",
        visibility: "local",
        sourceThreadId: "thread-1",
        createdBy: null,
        creationSource: null,
        senderThreadId: null,
        ...notification,
      },
    ],
  };
}

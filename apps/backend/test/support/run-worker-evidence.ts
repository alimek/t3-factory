import { assert, type TestContext } from "@effect/vitest";
import { directWorker, finishWorker } from "./run-worker.ts";
import { nativeChild, supplyChild } from "./native-root-evidence.ts";
import { nativeDelegation } from "./native-delegation.ts";

/** The descendant was saved, then dropped from the worker's current native activity while it still runs. */
export async function workerWithDroppedDescendant(c: TestContext) {
  const f = await directWorker(c, true, "");
  const delegated = nativeChild(nativeDelegation().input, "execution-1", 3, f.project.projectId);
  supplyChild(f.t3, delegated, f.project);
  const quiet = f.t3.delegationActivities.get("thread-1")!;
  f.t3.delegationActivities.set("thread-1", { ...quiet, invocations: [delegated], complete: true });
  assert((await f.f.reconcileRuns()).ok);
  const saved = await f.f.getRun(f.runId);
  assert(saved.ok);
  assert(
    saved.value.threadBindings.some(
      (binding) => binding.threadId === "thread-3" && binding.role === "descendant",
    ),
  );
  f.t3.delegationActivities.set("thread-1", quiet);
  finishWorker(f);
  return f;
}

import { assert, type TestContext } from "@effect/vitest";
import { directWorker, workerFinal } from "./run-worker.ts";
import { nativeChild } from "./native-root-evidence.ts";
import { nativeDelegation } from "./native-delegation.ts";

/** Only assessment sees this positive reference before the dependent tree read fails. */
export async function workerWithLostDescendantEvidence(c: TestContext) {
  const fixture = await directWorker(c);
  const activity = fixture.t3.delegationActivities.get("thread-2")!;
  const discovered = {
    ...activity,
    invocations: [
      nativeChild(nativeDelegation().input, "execution-2", 3, fixture.project.projectId),
    ],
  };
  const readTree = fixture.t3.readDescendants.bind(fixture.t3);
  const unavailableTree: typeof readTree = (target, threadId) => {
    if (threadId === "thread-2") return Promise.reject(Error("Tree read unavailable"));
    return readTree(target, threadId);
  };
  const readCall = fixture.t3.readRuntimeActivity.bind(fixture.t3);
  fixture.t3.readRuntimeActivity = async (...args) => {
    const call = await readCall(...args);
    // Publish after correlation's refresh, so only checkpoint preparation can retain it.
    if (args[3]) {
      fixture.t3.delegationActivities.set("thread-2", discovered);
      fixture.t3.readDescendants = unavailableTree;
    }
    return call;
  };
  const rejected = await fixture.f.runtime.submit(workerFinal());
  assert(rejected.code === "ASSESSMENT_UNVERIFIED", JSON.stringify(rejected));
  await fixture.f.close();
  fixture.t3.readRuntimeActivity = readCall;
  fixture.t3.readDescendants = readTree;
  fixture.t3.delegationActivities.set("thread-2", activity);
  const f = await fixture.h.open({ t3: fixture.t3 });
  return { ...fixture, f };
}

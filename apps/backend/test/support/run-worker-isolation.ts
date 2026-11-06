import { assert, type TestContext } from "@effect/vitest";
import { directWorker } from "./run-worker.ts";

export async function workerWithUnavailableRun(c: TestContext) {
  const fixture = await directWorker(c);
  const launch = fixture.t3.launchThread.bind(fixture.t3);
  fixture.t3.launchThread = async (target, payload) => {
    const reference = {
      ...(await launch(target, payload)),
      threadId: "unrelated-root",
      runId: "unrelated-execution",
    };
    fixture.t3.launches.set(payload.clientRequestId, { payload, reference });
    return reference;
  };
  const other = await fixture.f.startRun({ ...fixture.input, requestId: "unrelated-run" });
  assert(other.ok);
  await fixture.f.reconcileRuns();
  const read = fixture.t3.readExecution.bind(fixture.t3);
  let unrelatedReads = 0;
  fixture.t3.readExecution = (target, threadId, recorded) => {
    if (threadId === "unrelated-root") {
      unrelatedReads++;
      return Promise.reject(Error("Unrelated Run unavailable"));
    }
    return read(target, threadId, recorded);
  };
  return { ...fixture, unrelatedReads: () => unrelatedReads };
}

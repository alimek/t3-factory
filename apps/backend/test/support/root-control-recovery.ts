import { assert, type TestContext } from "@effect/vitest";
import { prepared } from "./prepared-runner.ts";
import { directWorker } from "./run-worker.ts";

/** Two Flow input targets: the first worker command rides on the Run conversation launch. */
async function twoTargetStart(c: TestContext) {
  const fixture = await prepared(c);
  const first = fixture.flow.graph.blocks[0]!;
  const flow = await fixture.f.updateFlow(fixture.flow.id, {
    ...fixture.flow,
    expectedRevision: fixture.flow.revision,
    graph: {
      ...fixture.flow.graph,
      blocks: [first, { ...first, id: "parallel-block", name: "Parallel work" }],
      flowInput: { ...fixture.flow.graph.flowInput, targetBlockIds: [first.id, "parallel-block"] },
    },
  });
  assert(flow.ok);
  return { ...fixture, flow: flow.value };
}

export async function failedRoot(c: TestContext) {
  const fixture = await twoTargetStart(c);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.reconcileRuns()).ok);
  await endRootControl(fixture);
  return { ...fixture, runId: started.value.id };
}

/** The Run conversation fails after its only worker command was natively accepted. */
export async function failedIssuedRoot(c: TestContext) {
  const fixture = await directWorker(c, true, "");
  await endRootControl(fixture);
  return { ...fixture, sourceExecutionId: "execution-1" };
}

async function endRootControl(
  fixture: {
    t3: import("./controlled-t3.ts").ControlledT3;
    f: import("../../src/open-factory.ts").Factory;
  },
  sourceExecutionId = "execution-1",
  status: "failed" | "cancelled" | "interrupted" = "failed",
) {
  endRootControlExecution(fixture.t3, sourceExecutionId, status);
  for (const [key, send] of fixture.t3.sends)
    fixture.t3.sends.set(key, { ...send, reference: { ...send.reference, status: "completed" } });
  assert((await fixture.f.reconcileRuns()).ok);
}

async function pendingRootCommand(c: TestContext) {
  const fixture = await twoTargetStart(c);
  fixture.t3.sendSupported = false;
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.reconcileRuns()).ok);
  return { ...fixture, runId: started.value.id };
}

export async function failedRootBeforeNativeRead(c: TestContext) {
  const fixture = await pendingRootCommand(c);
  fixture.t3.engineStatus = "failed";
  const read = fixture.t3.readDelegationActivity.bind(fixture.t3);
  fixture.t3.readDelegationActivity = async () => {
    throw Error("Native history unavailable");
  };
  assert((await fixture.f.reconcileRuns()).ok);
  fixture.t3.readDelegationActivity = read;
  await onlyReadOnlyRootHistory(fixture.t3, false);
  fixture.t3.sendSupported = true;
  await fixture.f.close();
  return fixture;
}

async function onlyReadOnlyRootHistory(
  t3: import("./controlled-t3.ts").ControlledT3,
  retainSource: boolean,
) {
  const original = await t3.readExecution({ endpoint: "controlled" }, "thread-1");
  t3.executionObservations.set("thread-1", {
    ...original,
    activeRunId: null,
    latestRunId: "read-only-chat",
    recentRuns: [
      ...(retainSource ? original.recentRuns : []),
      { runId: "read-only-chat", status: "completed", ordinal: 2 },
    ],
  });
}

function endRootControlExecution(
  t3: import("./controlled-t3.ts").ControlledT3,
  sourceExecutionId: string,
  status: "failed" | "cancelled" | "interrupted" | "rolled_back",
) {
  t3.engineStatus = status;
  const observation = t3.executionObservations.get("thread-1");
  if (observation)
    t3.executionObservations.set("thread-1", {
      ...observation,
      activeRunId: null,
      recentRuns: observation.recentRuns.map((run) =>
        run.runId === sourceExecutionId ? { ...run, status } : { ...run, status: "completed" },
      ),
    });
}

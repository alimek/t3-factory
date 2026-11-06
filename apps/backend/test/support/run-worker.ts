import { assert, type TestContext } from "@effect/vitest";
import type { ControlledT3 } from "./controlled-t3.ts";
import { prepared } from "./prepared-runner.ts";
import { contextCaller, nativeChild, supplyChild } from "./native-root-evidence.ts";
import { bindThreadReportCaller } from "./lifecycle-setup.ts";

/** The single-worker Flow, handing its result to a second worker, a Human review that
 * releases the second worker, back to itself, or nowhere. */
export async function workerStart(
  c: TestContext,
  targetBlockId: "parallel-block" | "review" | "worker" | "" = "parallel-block",
) {
  const fixture = await prepared(c);
  const first = fixture.flow.graph.blocks[0]!;
  const second = { ...first, id: "parallel-block", name: "Parallel work" };
  const review = {
    id: "review",
    kind: "human" as const,
    name: "Review",
    position: { x: 400, y: 0 },
    exits: first.exits,
  };
  const flow = await fixture.f.updateFlow(fixture.flow.id, {
    ...fixture.flow,
    expectedRevision: fixture.flow.revision,
    graph: {
      ...fixture.flow.graph,
      blocks:
        targetBlockId === "parallel-block"
          ? [first, second]
          : targetBlockId === "review"
            ? [first, review, second]
            : [first],
      connections: [
        ...(targetBlockId ? [{ sourceBlockId: first.id, exitId: "done", targetBlockId }] : []),
        ...(targetBlockId === "review"
          ? [{ sourceBlockId: "review", exitId: "done", targetBlockId: second.id }]
          : []),
      ],
    },
  });
  assert(flow.ok);
  return { ...fixture, flow: flow.value };
}
export async function directWorker(
  c: TestContext,
  observe = true,
  targetBlockId: Parameters<typeof workerStart>[1] = "parallel-block",
) {
  const fixture = await workerStart(c, targetBlockId);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok, JSON.stringify(started));
  await fixture.f.reconcileRuns();
  const payload = [...fixture.t3.launches.values()][0]!.payload;
  const invocation = nativeChild(
    JSON.parse(payload.message.split("\n").at(-1)!),
    "execution-1",
    2,
    fixture.project.projectId,
  );
  supplyChild(fixture.t3, invocation, fixture.project);
  fixture.t3.delegationActivities.set("thread-1", {
    threadId: "thread-1",
    projectId: fixture.project.projectId,
    complete: true,
    invocations: [invocation],
  });
  fixture.t3.descendantEvidence.set("thread-1", {
    parentThreadId: "thread-1",
    descendants: [
      { ...fixture.t3.childEvidence.get("thread-2")!.thread!, relationship: "t3-owned" },
    ],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Bounded scan",
  });
  contextCaller(fixture.t3, fixture.project.projectId, "thread-2", "execution-2");
  if (observe) assert((await fixture.f.reconcileRuns()).ok);
  bindThreadReportCaller(
    fixture.t3,
    fixture.project.projectId,
    "thread-2",
    "execution-2",
    "worker-report",
  );
  return { ...fixture, runId: started.value.id, invocation };
}
export const workerFinal = () => ({
  arguments: {
    key: "final",
    status: "finished",
    exit: "done",
    message: "Implemented the requested result.",
  },
  metadata: { callId: "worker-report" },
});
export function finishWorker(f: Awaited<ReturnType<typeof directWorker>>, status = "completed") {
  const prior = f.t3.executionObservations.get("thread-2")!;
  f.t3.executionObservations.set("thread-2", {
    ...prior,
    activeRunId: null,
    recentRuns: prior.recentRuns.map((r) => ({ ...r, status })),
  });
  const child = f.t3.childEvidence.get("thread-2")!;
  f.t3.childEvidence.set("thread-2", {
    ...child,
    thread: { ...child.thread!, activeRunId: null },
    execution: { ...child.execution!, status },
  });
  f.t3.delegatedSettlements.set(JSON.stringify(["thread-2", "execution-2"]), {
    threadId: "thread-2",
    runId: "execution-2",
    state: "settled",
    status,
    resultRun: { runId: "execution-2", status },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
}
export async function reportedWorker(
  c: TestContext,
  status = "completed",
  targetBlockId: Parameters<typeof workerStart>[1] = "parallel-block",
) {
  const f = await directWorker(c, true, targetBlockId);
  assert((await f.f.runtime.submit(workerFinal())).code === "ACCEPTED");
  finishWorker(f, status);
  return f;
}

/** A reported single worker whose own tree and the Run conversation are freshly quiet. */
export async function finishedWorker(c: TestContext) {
  const f = await reportedWorker(c, "completed", "");
  f.t3.engineStatus = "completed";
  settledAggregate(f.t3, "thread-1", "execution-1", "completed");
  return f;
}

/** The worker's result is waiting in a Human review whose answer hands off to a second worker. */
export async function pendingReview(c: TestContext) {
  const f = await reportedWorker(c, "completed", "review");
  assert((await f.f.reconcileRuns()).ok);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  const occurrence = run.value.humanOccurrences.find((o) => o.state === "pending");
  assert(occurrence);
  return { ...f, occurrence };
}

export async function waitingWorker(c: TestContext) {
  const f = await directWorker(c);
  assert(
    (
      await f.f.runtime.submit({
        arguments: { key: "question", status: "waiting", message: "Which audience?" },
        metadata: { callId: "worker-report" },
      })
    ).code === "ACCEPTED",
  );
  finishWorker(f);
  await f.f.reconcileRuns();
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  const question = run.value.attention.find(
    (a) => a.kind === "conversation-waiting" && !a.settledAt,
  )!;
  return { ...f, question };
}
export async function missingWorkerReport(c: TestContext) {
  const f = await directWorker(c);
  finishWorker(f);
  await f.f.reconcileRuns();
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  const missing = run.value.attention.find((a) => a.kind === "missing-report" && !a.settledAt)!;
  assert(missing);
  return { ...f, missing };
}
export async function revisitedWorker(c: TestContext) {
  const f = await reportedWorker(c, "completed", "worker");
  await f.f.reconcileRuns();
  return f;
}

/** Direct native replies omit senderThreadId; overrides exercise rejection at the public boundary. */
export async function workerNativeReply(
  c: TestContext,
  reply: Partial<ControlledT3["runtimeActivity"]["items"][number]> = {},
) {
  const f = await waitingWorker(c);
  supplyWorkerReply(f, reply);
  return f;
}

/** Publish native reply evidence independently of the backend's observation lifetime. */
export function supplyWorkerReply(
  f: Awaited<ReturnType<typeof waitingWorker>>,
  reply: Partial<ControlledT3["runtimeActivity"]["items"][number]> = {},
) {
  const prior = f.t3.executionObservations.get("thread-2")!;
  f.t3.executionObservations.set("thread-2", {
    ...prior,
    activeRunId: "answer-execution",
    latestRunId: "answer-execution",
    recentRuns: [...prior.recentRuns, { runId: "answer-execution", status: "running", ordinal: 2 }],
  });
  workerTurnSelection(f, "answer-execution");
  bindThreadReportCaller(
    f.t3,
    f.project.projectId,
    "thread-2",
    "answer-execution",
    "worker-report",
  );
  f.t3.runtimeActivity = {
    ...f.t3.runtimeActivity,
    items: [
      ...f.t3.runtimeActivity.items,
      {
        itemId: "user-answer",
        type: "message",
        runId: "answer-execution",
        text: "Public audience.",
        visibility: "local",
        sourceThreadId: "thread-2",
        createdBy: "user",
        ...reply,
      },
    ],
  };
}

function workerTurnSelection(f: Awaited<ReturnType<typeof directWorker>>, runId: string) {
  const child = f.t3.childEvidence.get("thread-2")!;
  const priorKey = JSON.stringify(["thread-2", child.execution!.runId]);
  if (!f.t3.childEvidence.has(priorKey)) f.t3.childEvidence.set(priorKey, child);
  const next = {
    ...child,
    target: { ...child.target, childRunId: runId },
    thread: { ...child.thread!, activeRunId: runId, latestRunId: runId },
    execution: { ...child.execution!, runId, status: "running" },
  };
  f.t3.childEvidence.set("thread-2", next);
  f.t3.childEvidence.set(JSON.stringify(["thread-2", runId]), next);
}

export async function revisitReportingWorker(c: TestContext) {
  const f = await revisitedWorker(c);
  const runId = [...f.t3.sends.values()][0]!.reference.runId;
  const prior = f.t3.executionObservations.get("thread-2")!;
  f.t3.executionObservations.set("thread-2", {
    ...prior,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: [...prior.recentRuns, { runId, status: "running", ordinal: 3 }],
  });
  workerTurnSelection(f, runId);
  bindThreadReportCaller(f.t3, f.project.projectId, "thread-2", runId, "worker-report");
  return { ...f, workerExecutionId: runId };
}

function settledAggregate(t3: ControlledT3, threadId: string, runId: string, status: string) {
  t3.delegatedSettlements.set(JSON.stringify([threadId, runId]), {
    threadId,
    runId,
    state: "settled",
    status,
    resultRun: { runId, status },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
}

/** The Run conversation is interrupted and its fully scanned tree has no further members. */
export function interruptRunConversation(t3: ControlledT3) {
  t3.engineStatus = "interrupted";
  if (!t3.descendantEvidence.has("thread-1"))
    t3.descendantEvidence.set("thread-1", {
      parentThreadId: "thread-1",
      descendants: [],
      scanComplete: true,
      coverage: "incomplete",
      problem: "Bounded fixture scan",
    });
  settledAggregate(t3, "thread-1", "execution-1", "interrupted");
}

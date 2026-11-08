import { assert, type TestContext } from "@effect/vitest";
import type { ControlledT3 } from "./controlled-t3.ts";
import { prepared } from "./prepared-runner.ts";

const WORKER_THREAD = "thread-1";
const WORKER_EXECUTION = "execution-1";

/** The single-worker Flow, handing its result to a second worker, a Human review that
 * releases the second worker, back to itself, or nowhere. */
export async function workerStart(
  c: TestContext,
  targetBlockId: "parallel-block" | "review" | "worker" | "" = "parallel-block",
  requiresFeedback = false,
) {
  const fixture = await prepared(c);
  const source = fixture.flow.graph.blocks[0]!;
  const first = requiresFeedback
    ? { ...source, exits: source.exits.map((exit) => ({ ...exit, requiresFeedback: true })) }
    : source;
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

/** Quiet top-level evidence for the Factory-launched worker, before that launch is observed. */
function seedFactoryWorker(
  t3: ControlledT3,
  project: { projectId: string; workspaceRoot: string },
) {
  t3.descendantEvidence.set(WORKER_THREAD, {
    parentThreadId: WORKER_THREAD,
    descendants: [],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Bounded fixture scan",
  });
  t3.executionObservations.set(WORKER_THREAD, {
    threadId: WORKER_THREAD,
    projectId: project.projectId,
    workspaceRoot: project.workspaceRoot,
    link: `t3://threads/${WORKER_THREAD}`,
    activeRunId: WORKER_EXECUTION,
    latestRunId: WORKER_EXECUTION,
    pendingRequestCount: 0,
    recentRuns: [{ runId: WORKER_EXECUTION, status: "running", ordinal: 1 }],
  });
}

/** A first or later visit message: the Block skill, the Block id line, then the turn's body. */
export function workerMessage(body: string) {
  return new RegExp(
    `^\\$factory-block\\n\\nFactory Block id: [0-9a-f-]{36}\\. Pass it as blockId to factory_get_block, factory_get_run and factory_update_block\\.\\n\\n${body.replaceAll(".", "\\.")}$`,
  );
}

/** The Block id Factory stated in a worker's launch message, as an Agent reads it. */
export function launchedBlockId(t3: ControlledT3, blockName = "Entry worker") {
  const launch = [...t3.launches.values()].find((entry) =>
    entry.payload.title.endsWith(` ${blockName}`),
  );
  return /Factory Block id: ([^.\s]+)/.exec(launch?.payload.message ?? "")?.[1] ?? "";
}

export async function directWorker(
  c: TestContext,
  observe = true,
  targetBlockId: Parameters<typeof workerStart>[1] = "parallel-block",
  requiresFeedback = false,
) {
  const fixture = await workerStart(c, targetBlockId, requiresFeedback);
  seedFactoryWorker(fixture.t3, fixture.project);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok, JSON.stringify(started));
  await fixture.f.reconcileRuns();
  if (observe) assert((await fixture.f.reconcileRuns()).ok);
  return { ...fixture, runId: started.value.id, blockId: launchedBlockId(fixture.t3) };
}
export const workerFinal = (blockId: string) => ({
  arguments: {
    blockId,
    to: "finished",
    exit: "done",
    message: "Implemented the requested result.",
  },
});
export function finishWorker(f: Awaited<ReturnType<typeof directWorker>>, status = "completed") {
  const prior = f.t3.executionObservations.get(WORKER_THREAD)!;
  f.t3.executionObservations.set(WORKER_THREAD, {
    ...prior,
    activeRunId: null,
    recentRuns: prior.recentRuns.map((r) => ({ ...r, status })),
  });
  f.t3.delegatedSettlements.set(JSON.stringify([WORKER_THREAD, WORKER_EXECUTION]), {
    threadId: WORKER_THREAD,
    runId: WORKER_EXECUTION,
    state: "settled",
    status,
    resultRun: { runId: WORKER_EXECUTION, status },
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
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  finishWorker(f, status);
  return f;
}

/** A reported single worker whose own tree is freshly quiet. */
export async function finishedWorker(c: TestContext) {
  const f = await reportedWorker(c, "completed", "");
  f.t3.engineStatus = "completed";
  settledAggregate(f.t3, WORKER_THREAD, WORKER_EXECUTION, "completed");
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
        arguments: { blockId: f.blockId, to: "waiting", message: "Which audience?" },
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
export async function missingWorkerReport(
  c: TestContext,
  worker?: Awaited<ReturnType<typeof directWorker>>,
) {
  const f = worker ?? (await directWorker(c));
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

/** The user's reply in the worker thread starts a new execution of that thread. */
export async function repliedWorker(c: TestContext) {
  const f = await waitingWorker(c);
  startWorkerTurn(f, "answer-execution", 2);
  return f;
}

/** A completed reply turn that omitted its report, followed by another user reply. */
export async function followupReplyWorker(c: TestContext) {
  const f = await repliedWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  finishWorker(f);
  assert((await f.f.reconcileRuns()).ok);
  startWorkerTurn(f, "followup-execution", 3);
  return f;
}

function startWorkerTurn(
  f: Awaited<ReturnType<typeof directWorker>>,
  executionId: string,
  ordinal: number,
) {
  const prior = f.t3.executionObservations.get(WORKER_THREAD)!;
  f.t3.executionObservations.set(WORKER_THREAD, {
    ...prior,
    activeRunId: executionId,
    latestRunId: executionId,
    recentRuns: [...prior.recentRuns, { runId: executionId, status: "running", ordinal }],
  });
}

export async function revisitReportingWorker(c: TestContext) {
  const f = await revisitedWorker(c);
  const runId = [...f.t3.sends.values()][0]!.reference.runId;
  const prior = f.t3.executionObservations.get(WORKER_THREAD)!;
  f.t3.executionObservations.set(WORKER_THREAD, {
    ...prior,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: [...prior.recentRuns, { runId, status: "running", ordinal: 3 }],
  });
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

/** The launched worker is interrupted and its fully scanned tree has no further members. */
export function interruptRunConversation(t3: ControlledT3) {
  t3.engineStatus = "interrupted";
  const observation = t3.executionObservations.get(WORKER_THREAD);
  if (observation)
    t3.executionObservations.set(WORKER_THREAD, {
      ...observation,
      activeRunId: null,
      latestRunId: observation.latestRunId ?? WORKER_EXECUTION,
      recentRuns: observation.recentRuns.map((run) => ({ ...run, status: "interrupted" })),
    });
  if (!t3.descendantEvidence.has(WORKER_THREAD))
    t3.descendantEvidence.set(WORKER_THREAD, {
      parentThreadId: WORKER_THREAD,
      descendants: [],
      scanComplete: true,
      coverage: "incomplete",
      problem: "Bounded fixture scan",
    });
  settledAggregate(t3, WORKER_THREAD, WORKER_EXECUTION, "interrupted");
}

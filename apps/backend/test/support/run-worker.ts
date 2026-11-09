import { assert, type TestContext } from "@effect/vitest";
import type { ControlledT3 } from "./controlled-t3.ts";
import { boundWorktreeReview, prepared } from "./prepared-runner.ts";
import { imageRequest, startedImageFanOut } from "./run-images.ts";

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

/** The Factory-launched worker's running first turn, before that launch is observed. */
function seedFactoryWorker(
  t3: ControlledT3,
  project: { projectId: string; workspaceRoot: string },
) {
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
    `^\\$factory-block\\n\\nFactory Block id: [0-9a-f-]{36}\\. Pass it as blockId to factory_get_block, factory_get_run, factory_get_run_image and factory_update_block\\.\\n\\n${body.replaceAll(".", "\\.")}$`,
  );
}

/** The Block id Factory stated in a worker's launch message, as an Agent reads it. */
export function launchedBlockId(t3: ControlledT3, blockName = "Entry worker") {
  const launch = [...t3.launches.values()].find((entry) =>
    entry.payload.title.endsWith(` ${blockName}`),
  );
  return /Factory Block id: ([^.\s]+)/.exec(launch?.payload.message ?? "")?.[1] ?? "";
}

/** Starts the Run with the entry worker's first turn running. */
async function startedWorker(
  fixture: Awaited<ReturnType<typeof prepared>>,
  observe: boolean,
  request: object = fixture.input,
) {
  seedFactoryWorker(fixture.t3, fixture.project);
  const started = await fixture.f.startRun(request);
  assert(started.ok, JSON.stringify(started));
  await fixture.f.reconcileRuns();
  if (observe) assert((await fixture.f.reconcileRuns()).ok);
  return { ...fixture, runId: started.value.id, blockId: launchedBlockId(fixture.t3) };
}

export async function directWorker(
  c: TestContext,
  observe = true,
  targetBlockId: Parameters<typeof workerStart>[1] = "parallel-block",
  requiresFeedback = false,
) {
  return startedWorker(await workerStart(c, targetBlockId, requiresFeedback), observe);
}

/** The entry worker hands "Done" to Parallel work and "Revise" to Follow-up. */
async function twoExitWorker(c: TestContext) {
  const fixture = await prepared(c);
  const source = fixture.flow.graph.blocks[0]!;
  const revise = {
    id: "revise",
    name: "Revise",
    description: "Needs another pass",
    outcome: "custom" as const,
    requiresFeedback: false,
  };
  const first = { ...source, exits: [...source.exits, revise] };
  const flow = await fixture.f.updateFlow(fixture.flow.id, {
    ...fixture.flow,
    expectedRevision: fixture.flow.revision,
    graph: {
      ...fixture.flow.graph,
      blocks: [
        first,
        { ...source, id: "parallel-block", name: "Parallel work" },
        { ...source, id: "follow-up", name: "Follow-up" },
      ],
      connections: [
        { sourceBlockId: first.id, exitId: "done", targetBlockId: "parallel-block" },
        { sourceBlockId: first.id, exitId: "revise", targetBlockId: "follow-up" },
      ],
    },
  });
  assert(flow.ok);
  return startedWorker({ ...fixture, flow: flow.value }, true);
}

/** The two-exit worker's "Done" result started Parallel work, and a later turn of the worker
 * thread is running. */
export async function releasedTwoExitWorker(c: TestContext) {
  const f = await twoExitWorker(c);
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  finishWorker(f);
  assert((await f.f.reconcileRuns()).ok);
  startWorkerTurn(f, "followup-execution", 2);
  return f;
}

/** The worker replaced its first result before release, and its thread is finished. */
export async function replacedBeforeRelease(c: TestContext) {
  const f = await directWorker(c);
  assert((await f.f.runtime.submit(workerFinal(f.blockId, "First draft."))).code === "ACCEPTED");
  assert((await f.f.runtime.submit(workerFinal(f.blockId, "Final result."))).code === "ACCEPTED");
  finishWorker(f);
  return f;
}

export const workerFinal = (
  blockId: string,
  message = "Implemented the requested result.",
  exit = "done",
) => ({ arguments: { blockId, to: "finished", exit, message } });
export const workerWorking = (blockId: string) => ({
  arguments: { blockId, to: "working", message: "Opened PR #42; waiting for its CI checks." },
});
/** The worker's runs end with `status` and T3 answers that the latest run's delegated and
 * background work have settled. */
export function finishWorker(f: Awaited<ReturnType<typeof directWorker>>, status = "completed") {
  const prior = f.t3.executionObservations.get(WORKER_THREAD)!;
  f.t3.executionObservations.set(WORKER_THREAD, {
    ...prior,
    activeRunId: null,
    recentRuns: prior.recentRuns.map((r) => ({ ...r, status })),
  });
  settleThread(f.t3, prior.latestRunId ?? WORKER_EXECUTION, status);
}

/** T3's `t3_thread_wait` answer for `runId` of the entry worker or another `threadId`. */
export function settleThread(
  t3: ControlledT3,
  runId: string,
  status = "completed",
  state: "settled" | "pending" = "settled",
  threadId = WORKER_THREAD,
) {
  t3.delegatedSettlements.set(JSON.stringify([threadId, runId]), {
    threadId,
    runId,
    state,
    status,
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

/** As `reportedWorker`, started with the image fixture's prompt. */
export async function reportedImageWorker(c: TestContext) {
  const fixture = await workerStart(c);
  const f = await startedWorker(fixture, true, await imageRequest(fixture));
  assert((await f.f.runtime.submit(workerFinal(f.blockId))).code === "ACCEPTED");
  finishWorker(f);
  return f;
}

/** The image fan-out Run with both Flow-input workers launched; `blockId` is Entry worker's. */
export async function launchedImageFanOut(c: TestContext) {
  const f = await startedImageFanOut(c);
  assert((await f.f.reconcileRuns()).ok);
  return { ...f, blockId: launchedBlockId(f.t3) };
}

/** A reported single worker whose thread is finished in T3. */
export async function finishedWorker(c: TestContext) {
  const f = await reportedWorker(c, "completed", "");
  f.t3.engineStatus = "completed";
  return f;
}

/** Resolves once T3 receives the next thread settlement, which Factory sends in the background
 * after a manual Settle. */
export function nextSettlement(t3: ControlledT3) {
  const settle = t3.settleThread.bind(t3);
  return new Promise<void>((resolve) => {
    t3.settleThread = async (target, payload) => {
      await settle(target, payload);
      resolve();
    };
  });
}

/** Resolves once T3 receives the next thread interrupt, which Factory sends in the background
 * after Archive. */
export function nextThreadInterrupt(t3: ControlledT3) {
  const interrupt = t3.stopThread.bind(t3);
  return new Promise<void>((resolve) => {
    t3.stopThread = async (target, payload) => {
      await interrupt(target, payload);
      resolve();
    };
  });
}

/** A worker's result is held for its next Block when the user archives the Run. */
export async function archivedWorker(c: TestContext) {
  const f = await reportedWorker(c);
  assert((await f.f.archiveRun(f.runId)).ok);
  return f;
}

/** A reported single worker whose Run settled automatically once its thread finished. */
export async function settledWorker(c: TestContext) {
  const f = await finishedWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  const run = await f.f.getRun(f.runId);
  assert(run.ok && run.value.lifecycle === "settled");
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

/** The worker's run failed and its execution-failed Problem was settled by a working report. */
export async function reportedAfterFailure(c: TestContext) {
  const f = await directWorker(c);
  finishWorker(f, "failed");
  assert((await f.f.reconcileRuns()).ok);
  assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
  return f;
}

/** A worker reported working and its turn completed, as after asking the user questions. */
export async function idleWorkingWorker(c: TestContext) {
  const f = await directWorker(c);
  assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
  finishWorker(f);
  assert((await f.f.reconcileRuns()).ok);
  return f;
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
  const f = await idleWorkingWorker(c);
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

/** A later run of the worker thread starts, as after a reply or a notification. */
export function startWorkerTurn(
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

/** Entry worker finished and the Review answered: Parallel work's first arrival waits to be sent. */
export async function answeredReview(
  c: TestContext,
  request?: Parameters<typeof boundWorktreeReview>[1],
) {
  const setup = await boundWorktreeReview(c, request);
  const { f, t3, runId, entryBlockId } = setup;
  assert((await f.runtime.submit(workerFinal(entryBlockId))).code === "ACCEPTED");
  t3.engineStatus = "completed";
  settleThread(t3, "execution-1", "completed", "settled", "thread-1");
  assert((await f.reconcileRuns()).ok);
  const review = await f.getRun(runId);
  assert(review.ok);
  const occurrence = review.value.humanOccurrences.find((o) => o.state === "pending")!;
  assert((await f.answerHumanOccurrence(occurrence.id, { exitId: "done" })).ok);
  return setup;
}

/** Parallel work's first turn on its own worker finished with a "Done" result, which returns to
 * Entry worker. */
export async function finishedParallelWork(
  c: TestContext,
  request?: Parameters<typeof boundWorktreeReview>[1],
) {
  const setup = await answeredReview(c, request);
  const { f, t3, project } = setup;
  assert((await f.reconcileRuns()).ok);
  const launched = [...t3.launches.values()][1]!;
  const parallelBlockId = /Factory Block id: ([^.\s]+)/.exec(launched.payload.message)![1]!;
  assert((await f.runtime.submit(workerFinal(parallelBlockId))).code === "ACCEPTED");
  const thread = await t3.readExecution(project, "thread-2");
  const { runId } = launched.reference;
  t3.executionObservations.set("thread-2", {
    ...thread,
    activeRunId: null,
    latestRunId: runId,
    recentRuns: [{ runId, status: "completed", ordinal: 1 }],
  });
  settleThread(t3, runId, "completed", "settled", "thread-2");
  // T3 starts the next queued turn on Entry worker's thread as soon as it accepts it.
  t3.beforeSend = async () => {
    t3.engineStatus = "running";
  };
  return setup;
}

/** A new working report arrives during the per-Block sweep's external completion read. */
export function reopenDuringSettlement(f: Awaited<ReturnType<typeof directWorker>>) {
  const inspect = f.t3.inspectSettleSupport.bind(f.t3);
  const read = f.t3.readDelegatedSettlement.bind(f.t3);
  f.t3.inspectSettleSupport = async (target) => {
    f.t3.inspectSettleSupport = inspect;
    f.t3.readDelegatedSettlement = async (...args) => {
      f.t3.readDelegatedSettlement = read;
      assert((await f.f.runtime.submit(workerWorking(f.blockId))).code === "ACCEPTED");
      return read(...args);
    };
    return inspect(target);
  };
}

import {
  allTurnsEnd,
  blockExit,
  finishedReport,
  launchBlockId,
  humanStep,
  connection,
  observe,
  report,
  startRun,
  turnBegins,
  turnEnds,
  workerHandle,
  workerObserved,
  workingReport,
} from "./scenarios.ts";
import { assert, type TestContext } from "@effect/vitest";
import type { RunDetail } from "@t3-factory/contracts";
import type { ControlledT3 } from "./controlled-t3.ts";
import { answerDelegatedWait, recordLaunchedThread } from "./controlled-thread.ts";
import { boundWorktreeReview, prepared } from "./prepared-runner.ts";
import { imageRequest, startedImageFanOut } from "./run-images.ts";

/** The single-worker Flow, handing its result to a second worker, a Human review that
 * releases the second worker, back to itself, or nowhere. */
export async function workerStart(
  c: TestContext,
  targetBlockId: "parallel-block" | "review" | "worker" | "" = "parallel-block",
  messageRequired = false,
) {
  const fixture = await prepared(c);
  if (messageRequired) {
    const { agent } = fixture;
    const updated = await fixture.f.updateAgent(agent.id, {
      ...agent,
      expectedRevision: agent.revision,
      exits: agent.exits.map((exit) => ({ ...exit, messageRequired: true })),
    });
    assert(updated.ok);
  }
  const first = fixture.flow.graph.blocks[0]!;
  const second = { ...first, id: "parallel-block", name: "Parallel work" };
  const review = humanStep("review", "Review", { x: 400, y: 0 });
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
        ...(targetBlockId ? [connection(first.id, "done", targetBlockId)] : []),
        ...(targetBlockId === "review" ? [connection("review", "approve", second.id)] : []),
      ],
    },
  });
  assert(flow.ok);
  return { ...fixture, flow: flow.value };
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
  return launchBlockId(launch?.payload.message ?? "");
}

/** Starts the Run with the entry worker's first turn running. */
async function startedWorker(
  fixture: Awaited<ReturnType<typeof prepared>>,
  observed: boolean,
  request: object = fixture.input,
) {
  const world = { factory: fixture.f, t3: fixture.t3 };
  const [worker] = (await startRun(world, request)).workers;
  assert(worker);
  if (observed) await observe(world, worker.runId, workerObserved);
  return { ...fixture, world, worker, runId: worker.runId, blockId: worker.blockId };
}

export async function directWorker(
  c: TestContext,
  observe = true,
  targetBlockId: Parameters<typeof workerStart>[1] = "parallel-block",
  messageRequired = false,
) {
  return startedWorker(await workerStart(c, targetBlockId, messageRequired), observe);
}

/** Entry worker's Agent has Done and Blocked; the Flow hides Blocked and adds a local Escalate. */
export async function exitVariantWorker(c: TestContext) {
  const fixture = await prepared(c);
  const { f, agent, flow } = fixture;
  const blocked = blockExit("blocked", "Blocked", "Explain the blocker.", true);
  const edited = await f.updateAgent(agent.id, {
    ...agent,
    expectedRevision: agent.revision,
    exits: [...agent.exits, blocked],
  });
  assert(edited.ok);
  const escalate = blockExit("escalate", "Escalate", "", true);
  const saved = await f.updateFlow(flow.id, {
    ...flow,
    expectedRevision: flow.revision,
    graph: {
      ...flow.graph,
      blocks: [{ ...flow.graph.blocks[0]!, hiddenExitIds: ["blocked"], localExits: [escalate] }],
    },
  });
  assert(saved.ok);
  return startedWorker({ ...fixture, flow: saved.value }, true);
}

/** The entry worker hands "Done" to Parallel work and "Revise" to Follow-up. */
async function twoExitWorker(c: TestContext) {
  const fixture = await prepared(c);
  const source = fixture.flow.graph.blocks[0]!;
  const revise = blockExit("revise", "Revise", "Needs another pass", false);
  const first = { ...source, localExits: [revise] };
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
        connection(first.id, "done", "parallel-block"),
        connection(first.id, "revise", "follow-up"),
      ],
    },
  });
  assert(flow.ok);
  return startedWorker({ ...fixture, flow: flow.value }, true);
}

/** The worker thread finishes and Factory observes it; then a follow-up turn of the thread runs. */
async function followUpTurn<F extends Awaited<ReturnType<typeof directWorker>>>(f: F) {
  allTurnsEnd(f.world, f.worker);
  assert((await f.f.reconcileRuns()).ok);
  return { ...f, worker: turnBegins(f.world, f.worker, "followup-execution") };
}

/** The two-exit worker's "Done" result started Parallel work, and a later turn of the worker
 * thread is running. */
export async function releasedTwoExitWorker(c: TestContext) {
  const f = await twoExitWorker(c);
  assert((await report(f.world, f.worker, finishedReport())) === "ACCEPTED");
  return followUpTurn(f);
}

/** The worker replaced its first result before release, and its thread is finished. */
export async function replacedBeforeRelease(c: TestContext) {
  const f = await directWorker(c);
  assert((await report(f.world, f.worker, finishedReport("First draft."))) === "ACCEPTED");
  assert((await report(f.world, f.worker, finishedReport("Final result."))) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);
  return f;
}

export async function reportedWorker(
  c: TestContext,
  status = "completed",
  targetBlockId: Parameters<typeof workerStart>[1] = "parallel-block",
) {
  const f = await directWorker(c, true, targetBlockId);
  assert((await report(f.world, f.worker, finishedReport())) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker, status);
  return f;
}

/** As `reportedWorker`, started with the image fixture's prompt. */
export async function reportedImageWorker(c: TestContext) {
  const fixture = await workerStart(c);
  const f = await startedWorker(fixture, true, await imageRequest(fixture));
  assert((await report(f.world, f.worker, finishedReport())) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);
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
  await observe(f.world, f.runId, (run) => run.lifecycle === "settled");
  return f;
}

/** The worker's result is waiting in a Human review whose answer hands off to a second worker. */
export async function pendingReview(c: TestContext) {
  const f = await reportedWorker(c, "completed", "review");
  const run = await observe(f.world, f.runId, (detail) =>
    detail.humanOccurrences.some((o) => o.state === "pending"),
  );
  const occurrence = run.humanOccurrences.find((o) => o.state === "pending");
  assert(occurrence);
  return { ...f, occurrence };
}

/** The worker's run failed and its execution-failed Problem was settled by a working report. */
export async function reportedAfterFailure(c: TestContext) {
  const f = await directWorker(c);
  allTurnsEnd(f.world, f.worker, "failed");
  assert((await f.f.reconcileRuns()).ok);
  assert((await report(f.world, f.worker, workingReport())) === "ACCEPTED");
  return f;
}

/** A worker reported working and its turn completed, as after asking the user questions. */
export async function idleWorkingWorker(c: TestContext) {
  const f = await directWorker(c);
  assert((await report(f.world, f.worker, workingReport())) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);
  assert((await f.f.reconcileRuns()).ok);
  return f;
}
export async function missingWorkerReport(
  c: TestContext,
  worker?: Awaited<ReturnType<typeof directWorker>>,
) {
  const f = worker ?? (await directWorker(c));
  allTurnsEnd(f.world, f.worker);
  const unreported = (a: RunDetail["attention"][number]) =>
    a.kind === "missing-report" && !a.settledAt;
  const run = await observe(f.world, f.runId, (detail) => detail.attention.some(unreported));
  const missing = run.attention.find(unreported);
  assert(missing);
  return { ...f, missing };
}
export async function revisitedWorker(c: TestContext) {
  const f = await reportedWorker(c, "completed", "worker");
  await f.f.reconcileRuns();
  return f;
}

/** The worker's result was released and its revisit prepared as a send, but T3 refused sends, so
 * the revisit is still unsent. */
export async function unsentRevisit(c: TestContext) {
  const f = await reportedWorker(c, "completed", "worker");
  f.t3.sendSupported = false;
  assert((await f.f.reconcileRuns()).ok);
  f.t3.sendSupported = true;
  return f;
}

/** The user's reply in the worker thread starts a new execution of that thread. */
export async function repliedWorker(c: TestContext) {
  const f = await idleWorkingWorker(c);
  return { ...f, worker: turnBegins(f.world, f.worker, "answer-execution") };
}

/** A completed reply turn that omitted its report, followed by another user reply. */
export async function followupReplyWorker(c: TestContext) {
  const f = await repliedWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  return followUpTurn(f);
}

/** The revisit's send runs as a new turn of the worker thread. */
export async function revisitReportingWorker(c: TestContext) {
  const f = await revisitedWorker(c);
  const runId = [...f.t3.sends.values()][0]!.reference.runId;
  return { ...f, worker: turnBegins(f.world, f.worker, runId), workerExecutionId: runId };
}

/** Entry worker finished and the Review answered: Parallel work's first arrival waits to be sent. */
export async function answeredReview(
  c: TestContext,
  request?: Parameters<typeof boundWorktreeReview>[1],
) {
  const setup = await boundWorktreeReview(c, request);
  const { f, t3, runId, world, entryWorker } = setup;
  assert((await report(world, entryWorker, finishedReport())) === "ACCEPTED");
  t3.engineStatus = "completed";
  answerDelegatedWait(t3, "thread-1", "execution-1", "settled", "completed");
  assert((await f.reconcileRuns()).ok);
  const review = await f.getRun(runId);
  assert(review.ok);
  const occurrence = review.value.humanOccurrences.find((o) => o.state === "pending")!;
  assert((await f.answerHumanOccurrence(occurrence.id, { exitId: "approve" })).ok);
  return setup;
}

/** Parallel work's first turn on its own worker finished with a "Done" result, which returns to
 * Entry worker. */
export async function finishedParallelWork(
  c: TestContext,
  request?: Parameters<typeof boundWorktreeReview>[1],
) {
  const setup = await answeredReview(c, request);
  const { f, t3, world, runId } = setup;
  assert((await f.reconcileRuns()).ok);
  const run = await f.getRun(runId);
  assert(run.ok);
  const parallel = workerHandle(world, run.value, "parallel-block");
  assert((await report(world, parallel, finishedReport())) === "ACCEPTED");
  await recordLaunchedThread(t3, parallel.threadId);
  turnEnds(world, parallel);
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
      assert((await report(f.world, f.worker, workingReport())) === "ACCEPTED");
      return read(...args);
    };
    return inspect(target);
  };
}

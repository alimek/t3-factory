import {
  allTurnsEnd,
  blockExit,
  finishedReport,
  launchBlockId,
  humanStep,
  connection,
  observe,
  report,
  resultReported,
  turnBegins,
  turnEnds,
  workerHandle,
  workerAtWork,
  workingReport,
  type ScenarioWorld,
  type WorkerHandle,
} from "./scenarios.ts";
import { assert, type TestContext } from "@effect/vitest";
import type { ControlledT3 } from "./controlled-t3.ts";
import { answerDelegatedWait, recordLaunchedThread } from "./controlled-thread.ts";
import { boundWorktreeReview, prepared } from "./prepared-runner.ts";
import { startedImageFanOut } from "./run-images.ts";

/** The single-worker Flow handing its result to a second worker, or to a Human review that
 * releases the second worker. */
export async function workerStart(
  c: TestContext,
  targetBlockId: "parallel-block" | "review" = "parallel-block",
) {
  const fixture = await prepared(c);
  const first = fixture.flow.graph.blocks[0]!;
  const second = { ...first, id: "parallel-block", name: "Parallel work" };
  const review = humanStep("review", "Review", { x: 400, y: 0 });
  const flow = await fixture.f.updateFlow(fixture.flow.id, {
    ...fixture.flow,
    expectedRevision: fixture.flow.revision,
    graph: {
      ...fixture.flow.graph,
      blocks: targetBlockId === "review" ? [first, review, second] : [first, second],
      connections: [
        connection(first.id, "done", targetBlockId),
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
  const setup = { ...fixture, flow: flow.value };
  const worker = await workerAtWork(setup.world, setup.input);
  return { ...setup, ...worker, worker };
}

/** The two-exit worker's "Done" result started Parallel work, and a later turn of the worker
 * thread is running. */
export async function releasedTwoExitWorker(c: TestContext) {
  const f = await twoExitWorker(c);
  assert((await report(f.world, f.worker, finishedReport())) === "ACCEPTED");
  allTurnsEnd(f.world, f.worker);
  assert((await f.f.reconcileRuns()).ok);
  return { ...f, worker: turnBegins(f.world, f.worker, "followup-execution") };
}

/** The worker replaced its first result before release, and its thread is finished. */
export async function replacedBeforeRelease(c: TestContext) {
  const setup = await workerStart(c);
  const worker = await workerAtWork(setup.world, setup.input);
  assert((await report(setup.world, worker, finishedReport("First draft."))) === "ACCEPTED");
  assert((await report(setup.world, worker, finishedReport("Final result."))) === "ACCEPTED");
  allTurnsEnd(setup.world, worker);
  return { ...setup, ...worker, worker };
}

/** The image fan-out Run with both Flow-input workers launched; `blockId` is Entry worker's. */
export async function launchedImageFanOut(c: TestContext) {
  const f = await startedImageFanOut(c);
  assert((await f.f.reconcileRuns()).ok);
  return { ...f, blockId: launchedBlockId(f.t3) };
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

/** The worker's result is waiting in a Human review whose answer hands off to a second worker. */
export async function pendingReview(c: TestContext) {
  const setup = await workerStart(c, "review");
  const worker = await resultReported(setup.world, await workerAtWork(setup.world, setup.input));
  const run = await observe(setup.world, worker.runId, (detail) =>
    detail.humanOccurrences.some((o) => o.state === "pending"),
  );
  const occurrence = run.humanOccurrences.find((o) => o.state === "pending");
  assert(occurrence);
  return { ...setup, ...worker, worker, occurrence };
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
export function reopenDuringSettlement(world: ScenarioWorld, worker: WorkerHandle) {
  const { t3 } = world;
  const inspect = t3.inspectSettleSupport.bind(t3);
  const read = t3.readDelegatedSettlement.bind(t3);
  t3.inspectSettleSupport = async (target) => {
    t3.inspectSettleSupport = inspect;
    t3.readDelegatedSettlement = async (...args) => {
      t3.readDelegatedSettlement = read;
      assert((await report(world, worker, workingReport())) === "ACCEPTED");
      return read(...args);
    };
    return inspect(target);
  };
}

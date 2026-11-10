import type { RunDetail } from "@t3-factory/contracts";
import {
  allTurnsEnd,
  launchBlockId,
  observeFor,
  reach,
  sentTurnBegins,
  type ScenarioWorld,
  type WorkerHandle,
} from "./scenarios.ts";

/*
 * Named Run states around a Continuation whose prompt continues a worker's thread. The worker's
 * own handle stays on its thread; the prompt is the latest send T3 accepted on it.
 */

const continuation = (run: RunDetail, blockId: string) =>
  run.blocks.find((block) => block.blockId === blockId);

/** The prompt Factory queued on `worker`'s thread for a Continuation, and the Block id it states. */
export function promptOn(world: ScenarioWorld, worker: WorkerHandle) {
  const send = [...world.t3.sends.values()]
    .filter((entry) => entry.payload.threadId === worker.threadId)
    .at(-1);
  if (!send) throw Error(`T3 received no prompt on ${worker.threadId}.`);
  return { message: send.payload.message, blockId: launchBlockId(send.payload.message) };
}

/** Factory observed the worker's released result reach Continuation `blockId` and queued its
 * prompt on the worker's thread; the prompt's turn has not started. */
export function promptSent(world: ScenarioWorld, worker: WorkerHandle, blockId = "spec") {
  return reach("prompt sent", async () => {
    await observeFor(
      "observe the prompt",
      world,
      worker.runId,
      (run) => continuation(run, blockId)?.state === "sent",
    );
    return promptOn(world, worker);
  });
}

/** The prompt's turn ran on the worker's thread: the worker reported `finished` with `message` for
 * the Continuation's Block id, and every turn of the thread ended. Factory has not yet observed
 * the end. */
export function promptAnswered(
  world: ScenarioWorld,
  worker: WorkerHandle,
  prompt: { readonly blockId: string },
  message = "Spec written: docs/spec.md.",
) {
  return reach("prompt answered", async () => {
    const turn = sentTurnBegins(world, worker);
    const reply = await world.factory.runtime.submit({
      arguments: { blockId: prompt.blockId, to: "finished", message },
    });
    if (reply.code !== "ACCEPTED") throw Error(`The Continuation's report answered ${reply.code}.`);
    allTurnsEnd(world, turn);
    return turn;
  });
}

/** As `promptAnswered`, and Factory observed the end and forwarded the response: the
 * Continuation passes every later message through. */
export function responseForwarded(
  world: ScenarioWorld,
  worker: WorkerHandle,
  prompt: { readonly blockId: string },
  blockId = "spec",
) {
  return reach("response forwarded", async () => {
    await promptAnswered(world, worker, prompt);
    return observeFor(
      "observe the forwarded response",
      world,
      worker.runId,
      (run) => continuation(run, blockId)?.state === "pass-through",
    );
  });
}

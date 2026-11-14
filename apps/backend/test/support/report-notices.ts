import { isNotice, noticesIn } from "./chat-actions.ts";
import type { ControlledDiscord } from "./controlled-discord.ts";
import { recordThreadFacts } from "./controlled-thread.ts";
import { observeFor, type ScenarioWorld, type WorkerHandle } from "./scenarios.ts";

/** Resolves with the `ordinal`-th notice Discord shows (1 is the first) once it exists. */
export async function noticeCreated(discord: ControlledDiscord, ordinal = 1) {
  await discord.createdWhere(isNotice, ordinal);
  return noticesIn(discord)[ordinal - 1]!;
}

const pendingNativeRequest = (run: Awaited<ReturnType<typeof observeFor>>) =>
  run.attention.some((matter) => matter.kind === "native-request" && matter.settledAt === null);

/** T3 shows a pending native request in the worker's thread and Factory observed it. */
export async function nativeRequestShown(world: ScenarioWorld, worker: WorkerHandle) {
  recordThreadFacts(world.t3, worker.threadId, { pendingRequestCount: 1 });
  await observeFor("observe the native request", world, worker.runId, pendingNativeRequest);
}

/** The request was answered in T3, which shows none pending, and Factory settled it. */
export async function nativeRequestAnswered(world: ScenarioWorld, worker: WorkerHandle) {
  recordThreadFacts(world.t3, worker.threadId, { pendingRequestCount: 0 });
  await observeFor(
    "observe the native request answered",
    world,
    worker.runId,
    (run) => !pendingNativeRequest(run),
  );
}

import type { Factory } from "../../apps/backend/src/index.ts";
import type { PersistentT3 } from "./persistent-t3.ts";
import { finishNativeTurn } from "./native-simulation.ts";
import type { Result, RunBlock, RunDetail } from "../../packages/contracts/src/index.ts";

export function requireSuccess<A>(result: Result<A>): A {
  if (!result.ok) throw Error(`Development seed: ${result.error.message}`);
  return result.value;
}

export function executionBlock(run: RunDetail, blockId = "worker") {
  const block = run.blocks.find((item) => item.blockId === blockId);
  if (!block?.threadId || !block.executionId)
    throw Error(`Development seed: ${run.title} has no ${blockId} execution.`);
  return { ...block, threadId: block.threadId, executionId: block.executionId };
}

/** The Block id Factory stated in the worker's launch message, as its Agent reads it. */
export function launchedBlockId(t3: PersistentT3, threadId: string) {
  const launch = [...t3.launches.values()].find((entry) => entry.reference.threadId === threadId);
  const blockId = /Factory Block id: ([^.\s]+)/.exec(launch?.payload.message ?? "")?.[1];
  if (!blockId) throw Error(`Development seed: thread ${threadId} has no Block id.`);
  return blockId;
}

export interface SeedContext {
  factory: Factory;
  t3: PersistentT3;
  projectId: string;
}

/** Bounded reconciliation, with an observable condition rather than elapsed time. */
export async function reconcileUntil(
  context: SeedContext,
  runId: string,
  ready: (run: RunDetail) => boolean,
): Promise<RunDetail> {
  for (let pass = 0; pass < 12; pass++) {
    requireSuccess(await context.factory.reconcileRuns());
    await context.t3.advance();
    const run = requireSuccess(await context.factory.getRun(runId));
    if (ready(run)) return run;
  }
  throw Error(`Development seed did not settle Run ${runId}.`);
}

export async function startScenario(
  context: SeedContext,
  flowId: string,
  key: string,
  title: string,
  prompt: string,
) {
  const run = requireSuccess(
    await context.factory.startRun({
      requestId: `development-v1:${key}`,
      projectId: context.projectId,
      flowId,
      input: `Demo · ${title}\n\n${prompt}`,
      title: `Demo · ${title}`,
      createdAt: new Date().toISOString(),
    }),
  );
  return reconcileUntil(context, run.id, (detail) =>
    detail.blocks.some((block) => block.threadId !== null && block.freshness === "fresh"),
  );
}

/** Simulated Agent reports enter the public runtime boundary with the Block id. */
export async function report(
  context: SeedContext,
  run: RunDetail,
  blockId: string,
  value: { to: "finished" | "waiting"; exit?: string; message?: string },
) {
  const block = executionBlock(run, blockId);
  const reply = await context.factory.runtime.submit({
    arguments: { blockId: launchedBlockId(context.t3, block.threadId), ...value },
  });
  if (reply.code !== "ACCEPTED") throw Error(`Development report: ${reply.code}`);
  return reconcileUntil(context, run.id, (detail) =>
    value.to === "waiting"
      ? detail.attention.some(
          (item) => item.kind === "conversation-waiting" && item.settledAt === null,
        )
      : detail.reports.some((item) => item.blockId === blockId && item.status === value.to),
  );
}

export async function observeTerminal(
  t3: PersistentT3,
  block: RunBlock,
  status: "completed" | "failed" | "interrupted",
) {
  if (!block.threadId || !block.executionId) throw Error("Development seed execution missing.");
  finishNativeTurn(t3, block.threadId, block.executionId, status);
  t3.save();
}

export async function nativeAttention(context: SeedContext, run: RunDetail) {
  const block = executionBlock(run);
  const observation = await context.t3.readExecution({ endpoint: "" }, block.threadId);
  context.t3.executionObservations.set(block.threadId, {
    ...observation,
    pendingRequestCount: 1,
  });
  return reconcileUntil(context, run.id, (detail) =>
    detail.attention.some(
      (matter) => matter.kind === "native-request" && matter.settledAt === null,
    ),
  );
}

export async function failScenarioExecution(context: SeedContext, run: RunDetail) {
  await observeTerminal(context.t3, executionBlock(run), "failed");
}

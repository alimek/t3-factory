import type { Factory } from "../../apps/backend/src/index.ts";
import type { PersistentT3 } from "./persistent-t3.ts";
import { finishNativeTurn } from "./native-simulation.ts";
import type {
  PromptSegment,
  Result,
  RunBlock,
  RunDetail,
} from "../../packages/contracts/src/index.ts";
import { sha256Hex, solidPng } from "../../apps/backend/test/support/run-images.ts";
import type { ExecutionObservation } from "../../apps/backend/src/adapters/t3.ts";

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

/** Repository facts belong to simulated T3 workers, never direct Factory database writes. */
export async function scenarioRepository(
  context: SeedContext,
  run: RunDetail,
  blockId: string,
  repository: NonNullable<ExecutionObservation["repository"]>,
) {
  const worker = executionBlock(run, blockId);
  const observation = await context.t3.readExecution({ endpoint: "" }, worker.threadId);
  context.t3.executionObservations.set(worker.threadId, { ...observation, repository });
  context.t3.save();
  return reconcileUntil(context, run.id, (detail) =>
    detail.repositories.some(
      (item) =>
        item.threadId === worker.threadId &&
        item.branch === repository.branch &&
        item.pullRequests.length === repository.pullRequests.length,
    ),
  );
}

export const demoPullRequest = (number: number, state: "open" | "merged" = "open") => ({
  host: "github.com",
  repository: "example/atlas",
  number,
  state,
  url: `https://github.com/example/atlas/pull/${number}`,
});

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

/** Distinguishable demo screenshots; two share an original filename. */
export const demoImages = {
  headerDesktop: { name: "screenshot.png", data: solidPng(220, 40, 40) },
  headerMobile: { name: "screenshot.png", data: solidPng(40, 70, 220) },
  focusRing: { name: "focus-ring.png", data: solidPng(240, 180, 30) },
  mockup: { name: "settings-mockup.png", data: solidPng(40, 180, 90) },
};
type DemoImage = (typeof demoImages)[keyof typeof demoImages];

/**
 * The Start prompt with its images staged first, as the composer does. The first `referenced`
 * images appear inline after the text; the rest stay attached without a reference.
 */
async function scenarioPrompt(
  context: SeedContext,
  text: string,
  attachments: { images: readonly DemoImage[]; referenced: number },
) {
  const images = attachments.images.map((image, index) => ({
    imageId: `image-${index + 1}`,
    sha256: sha256Hex(image.data),
    name: image.name,
    mimeType: "image/png" as const,
    sizeBytes: image.data.byteLength,
  }));
  for (const [index, image] of attachments.images.entries())
    requireSuccess(
      await context.factory.stageRunImage(images[index]!.sha256, {
        mimeType: "image/png",
        data: image.data,
      }),
    );
  const segments: PromptSegment[] = [{ type: "text", text }];
  for (const [index, image] of images.slice(0, attachments.referenced).entries())
    segments.push(
      { type: "text", text: index === 0 ? "\n\nCompare " : " with " },
      { type: "image", imageId: image.imageId },
    );
  return { segments, images };
}

export async function startScenario(
  context: SeedContext,
  flowId: string,
  key: string,
  title: string,
  prompt: string,
  attachments: { images: readonly DemoImage[]; referenced: number } = { images: [], referenced: 0 },
) {
  const run = requireSuccess(
    await context.factory.startRun({
      requestId: `development-v1:${key}`,
      projectId: context.projectId,
      flowId,
      ...(await scenarioPrompt(context, `Demo · ${title}\n\n${prompt}`, attachments)),
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
  value: { to: "finished" | "working"; exit?: string; message?: string },
) {
  const block = executionBlock(run, blockId);
  const reply = await context.factory.runtime.submit({
    arguments: { blockId: launchedBlockId(context.t3, block.threadId), ...value },
  });
  if (reply.code !== "ACCEPTED") throw Error(`Development report: ${reply.code}`);
  return reconcileUntil(context, run.id, (detail) => {
    if (value.to === "working")
      return detail.blocks.some(
        (item) => item.blockId === blockId && item.workingMessage === value.message,
      );
    return detail.reports.some((item) => item.blockId === blockId && item.status === value.to);
  });
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

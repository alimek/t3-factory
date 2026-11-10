import {
  observe,
  sha256Hex,
  solidPng,
  startRun,
  workerHandle,
  workerObserved,
} from "../../apps/backend/test/support/scenarios.ts";
import type { Factory } from "../../apps/backend/src/index.ts";
import type { PersistentT3 } from "./persistent-t3.ts";
import type { PromptSegment, Result, RunDetail } from "../../packages/contracts/src/index.ts";
import type { ExecutionObservation } from "../../apps/backend/src/adapters/t3.ts";

export function requireSuccess<A>(result: Result<A>): A {
  if (!result.ok) throw Error(`Development seed: ${result.error.message}`);
  return result.value;
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
  const worker = workerHandle(context, run, blockId);
  const observation = await context.t3.readExecution({ endpoint: "" }, worker.threadId);
  context.t3.executionObservations.set(worker.threadId, { ...observation, repository });
  context.t3.save();
  return observe(context, run.id, (detail) =>
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

/** Starts a demo Run under its stable logical key and title; Factory then observes its first
 * worker. */
export async function startDemoRun(
  context: SeedContext,
  flowId: string,
  key: string,
  title: string,
  prompt: string,
  attachments: { images: readonly DemoImage[]; referenced: number } = { images: [], referenced: 0 },
) {
  const { run } = await startRun(context, {
    requestId: `development-v1:${key}`,
    projectId: context.projectId,
    flowId,
    ...(await scenarioPrompt(context, `Demo · ${title}\n\n${prompt}`, attachments)),
    title: `Demo · ${title}`,
    createdAt: new Date().toISOString(),
  });
  return observe(context, run.id, workerObserved);
}

export async function nativeAttention(context: SeedContext, run: RunDetail) {
  const worker = workerHandle(context, run, "worker");
  const observation = await context.t3.readExecution({ endpoint: "" }, worker.threadId);
  context.t3.executionObservations.set(worker.threadId, {
    ...observation,
    pendingRequestCount: 1,
  });
  return observe(context, run.id, (detail) =>
    detail.attention.some(
      (matter) => matter.kind === "native-request" && matter.settledAt === null,
    ),
  );
}

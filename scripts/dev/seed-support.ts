import {
  idleWorking,
  observeFor,
  reach,
  sha256Hex,
  solidPng,
  type WorkerHandle,
} from "../../apps/backend/test/support/scenarios.ts";
import type { Factory } from "../../apps/backend/src/index.ts";
import type { PersistentT3 } from "./persistent-t3.ts";
import type { PromptSegment, Result } from "../../packages/contracts/src/index.ts";

export function requireSuccess<A>(result: Result<A>): A {
  if (!result.ok) throw Error(`Development seed: ${result.error.message}`);
  return result.value;
}

export interface SeedContext {
  factory: Factory;
  t3: PersistentT3;
  projectId: string;
}

export const demoPullRequest = (number: number, state: "open" | "merged" = "open") => ({
  host: "github.com",
  repository: "example/atlas",
  number,
  state,
  url: `https://github.com/example/atlas/pull/${number}`,
});

/**
 * Distinguishable demo screenshots; two share an original filename. Only Settled or Archived Runs
 * use `compactNavigation` and `welcomeCopy`, so Settings lists them as Run images.
 */
export const demoImages = {
  headerDesktop: { name: "screenshot.png", data: solidPng(220, 40, 40) },
  headerMobile: { name: "screenshot.png", data: solidPng(40, 70, 220) },
  focusRing: { name: "focus-ring.png", data: solidPng(240, 180, 30) },
  mockup: { name: "settings-mockup.png", data: solidPng(40, 180, 90) },
  compactNavigation: { name: "compact-navigation.png", data: solidPng(150, 90, 210) },
  welcomeCopy: { name: "welcome-copy.png", data: solidPng(30, 170, 190) },
};
export type DemoImage = (typeof demoImages)[keyof typeof demoImages];

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

export interface ScenarioNamespace {
  titlePrefix: string;
  keyNamespace: string;
}

export const demoNamespace: ScenarioNamespace = {
  titlePrefix: "Demo · ",
  keyNamespace: "development-v1:",
};

/** A demo Run's Start: its stable logical key, title and prompt, with its images staged. */
export async function demoStart(
  context: SeedContext,
  flowId: string,
  key: string,
  title: string,
  prompt: string,
  attachments: { images: readonly DemoImage[]; referenced: number } = { images: [], referenced: 0 },
  namespace: ScenarioNamespace = demoNamespace,
) {
  return {
    requestId: `${namespace.keyNamespace}${key}`,
    projectId: context.projectId,
    flowId,
    ...(await scenarioPrompt(
      context,
      `${namespace.titlePrefix}${title}\n\n${prompt}`,
      attachments,
    )),
    title: `${namespace.titlePrefix}${title}`,
    createdAt: new Date().toISOString(),
  };
}

/** Named Run state only the persistent simulator reaches, from a worker at work: the worker
 * delegated to `subagents` simulated subagents that keep running, and its own turn completed. T3
 * answers its delegated wait as pending, so Factory observed it idle in working without a missing
 * report. */
export function delegatedWorkPending(world: SeedContext, worker: WorkerHandle, subagents: number) {
  return reach("delegated work pending", async () => {
    for (let index = 0; index < subagents; index++)
      world.t3.delegate(worker.threadId, worker.executionId);
    await observeFor("observe the idle worker", world, worker.runId, idleWorking(worker));
    return worker;
  });
}

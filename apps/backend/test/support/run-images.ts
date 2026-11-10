import { solidPng, sha256Hex } from "./scenarios.ts";
import { assert, type TestContext } from "@effect/vitest";
import type { ControlledT3 } from "./controlled-t3.ts";
import { preparedFanOutFlow } from "./prepared-runner.ts";
import type { Factory, FactoryService } from "../../src/index.ts";
import * as Effect from "effect/Effect";
import type { PromptSegment, RunImage, StartRunInput } from "@t3-factory/contracts";

/** Red and blue screenshots share an original filename; green has its own. */
export const screenshots = {
  red: { name: "screenshot.png", data: solidPng(220, 40, 40) },
  blue: { name: "screenshot.png", data: solidPng(40, 70, 220) },
  green: { name: "mockup.png", data: solidPng(40, 180, 90) },
};

export function manifestEntry(
  imageId: string,
  image: { name: string; data: Uint8Array },
): RunImage {
  return {
    imageId,
    sha256: sha256Hex(image.data),
    name: image.name,
    mimeType: "image/png",
    sizeBytes: image.data.byteLength,
  };
}

/** Stages every image's bytes, as the composer does before Start. */
export async function stageImages(
  factory: Pick<Factory, "stageRunImage">,
  images: readonly { name: string; data: Uint8Array }[],
) {
  for (const image of images) {
    const staged = await factory.stageRunImage(sha256Hex(image.data), {
      mimeType: "image/png",
      data: image.data,
    });
    assert(staged.ok, JSON.stringify(staged));
  }
}

/** As `stageImages`, on backend services whose operations are Effects (TestClock time). */
export function stageImageEffects(
  factory: Pick<FactoryService["Service"], "stageRunImage">,
  images: readonly { name: string; data: Uint8Array }[],
) {
  return Effect.forEach(
    images,
    (image) =>
      Effect.map(
        factory.stageRunImage(sha256Hex(image.data), { mimeType: "image/png", data: image.data }),
        (staged) => assert(staged.ok, JSON.stringify(staged)),
      ),
    { discard: true },
  );
}

/**
 * The fixture's Start in the current prompt shape: the text references red inline, and blue and
 * green stay attached without a reference.
 */
export function imageStart(input: {
  requestId: string;
  projectId: string;
  flowId: string;
  title: string;
  createdAt: string;
}): StartRunInput {
  const images = [
    manifestEntry("red", screenshots.red),
    manifestEntry("blue", screenshots.blue),
    manifestEntry("green", screenshots.green),
  ];
  const segments: PromptSegment[] = [
    { type: "text", text: "Fix the header shown in " },
    { type: "image", imageId: "red" },
    { type: "text", text: ".\nKeep the footer." },
  ];
  return {
    requestId: input.requestId,
    projectId: input.projectId,
    flowId: input.flowId,
    title: input.title,
    createdAt: input.createdAt,
    segments,
    images,
  };
}

/** Stages the fixture's images and returns its image Start for a prepared Flow. */
export async function imageRequest(setup: {
  f: Pick<Factory, "stageRunImage">;
  input: Parameters<typeof imageStart>[0];
}) {
  await stageImages(setup.f, Object.values(screenshots));
  return imageStart(setup.input);
}

/**
 * Holds the Runner's first image dispatch at its attachment check until released; Start's own
 * preflight check passes. Lets a test change Factory storage or T3 support after Start.
 */
function holdImageDispatch(t3: ControlledT3) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inspections = 0;
  t3.beforeAttachmentInspection = () => (++inspections > 1 ? released : Promise.resolve());
  return release;
}

/** The two-entry checkout Flow started with the image fixture's prompt, before any dispatch. */
export async function startedImageFanOut(c: TestContext, hold = false) {
  const fixture = await preparedFanOutFlow(c);
  await stageImages(fixture.f, Object.values(screenshots));
  const release = hold ? holdImageDispatch(fixture.t3) : () => {};
  const started = await fixture.f.startRun(imageStart(fixture.input));
  assert(started.ok, JSON.stringify(started));
  return { ...fixture, runId: started.value.id, release };
}

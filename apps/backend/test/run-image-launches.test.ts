import { rm } from "node:fs/promises";
import { join } from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { reportedImageWorker } from "./support/run-worker.ts";
import { screenshots, startedImageFanOut } from "./support/run-images.ts";
import { sha256Hex } from "./support/scenarios.ts";

const attachmentNames = ["image-1-screenshot.png", "image-2-screenshot.png", "image-3-mockup.png"];
const digests = [screenshots.red, screenshots.blue, screenshots.green].map((image) =>
  sha256Hex(image.data),
);

it("every Flow-input worker receives the same original images, uploaded anew for its launch", async (c) => {
  // Arrange
  const f = await startedImageFanOut(c);

  // Act
  assert((await f.f.reconcileRuns()).ok);

  // Assert
  const launches = [...f.t3.launches.values()].map((launch) => launch.payload);
  expect(launches.map((launch) => launch.title)).toStrictEqual([
    "Factory #1 · 1 Entry worker",
    "Factory #1 · 2 Second entry",
  ]);
  expect(launches.map((launch) => launch.attachments?.map((a) => a.name))).toStrictEqual([
    attachmentNames,
    attachmentNames,
  ]);
  const uploadedDigests = launches.map((launch) =>
    launch.attachments?.map((a) => sha256Hex(f.t3.uploads.get(a.id)!.data)),
  );
  expect(uploadedDigests).toStrictEqual([digests, digests]);
  expect(new Set(launches.flatMap((launch) => launch.attachments!.map((a) => a.id))).size).toBe(6);
  expect(launches[0]!.message).toContain(
    "Initial prompt images are attached to this message as image-1-screenshot.png, image-2-screenshot.png, image-3-mockup.png; references like [Image N: name] in the initial prompt point to them.",
  );
});

it("a failed image upload leaves the launch pending with the upload problem and launches nothing", async (c) => {
  // Arrange
  const f = await startedImageFanOut(c, true);
  f.t3.failUploads = true;
  f.release();

  // Act
  assert((await f.f.reconcileRuns()).ok);

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(f.t3.launchCalls).toBe(0);
  expect(run.value.intents.map((intent) => [intent.state, intent.problem])).toStrictEqual([
    ["pending", "Image upload to T3 failed: T3 answered the upload with HTTP 500."],
    ["pending", "Image upload to T3 failed: T3 answered the upload with HTTP 500."],
  ]);
  expect(run.value.blocks.map((block) => [block.state, block.problem])).toStrictEqual([
    ["not-started", null],
    ["not-started", null],
    ["not-started", null],
  ]);
  expect(run.value.attention).toStrictEqual([]);
});

it("a pending image launch uploads its images again after restart once T3 accepts attachments", async (c) => {
  // Arrange
  const f = await startedImageFanOut(c, true);
  f.t3.attachmentsSupported = false;
  f.release();
  assert((await f.f.reconcileRuns()).ok);
  await f.f.close();
  f.t3.attachmentsSupported = true;
  const reopened = await f.h.open({ t3: f.t3, connectionRetryMs: 60_000 });

  // Act
  assert((await reopened.reconcileRuns()).ok);

  // Assert
  const launches = [...f.t3.launches.values()].map((launch) => launch.payload);
  expect(launches.map((launch) => launch.attachments?.map((a) => a.name))).toStrictEqual([
    attachmentNames,
    attachmentNames,
  ]);
  expect(f.t3.uploadCalls).toBe(6);
});

it("Run image bytes missing from Factory storage cancel the launch with a Block error", async (c) => {
  // Arrange
  const f = await startedImageFanOut(c, true);
  await rm(join(f.h.processHome, "images", digests[1]!));
  f.release();

  // Act
  assert((await f.f.reconcileRuns()).ok);

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(f.t3.launchCalls).toBe(0);
  expect(run.value.intents.map((intent) => intent.state)).toStrictEqual(["cancelled", "cancelled"]);
  expect(run.value.blocks.slice(0, 2).map((block) => [block.state, block.problem])).toStrictEqual([
    ["error", "Run image missing from Factory storage"],
    ["error", "Run image missing from Factory storage"],
  ]);
});

it("an image launch with a lost acknowledgement is searched for, never uploaded or launched again", async (c) => {
  // Arrange
  const f = await startedImageFanOut(c, true);
  f.t3.loseLaunchReply = true;
  f.release();
  assert((await f.f.reconcileRuns()).ok);
  f.t3.loseLaunchReply = false;

  // Act
  assert((await f.f.reconcileRuns()).ok);

  // Assert
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(f.t3.launchCalls).toBe(2);
  expect(f.t3.uploadCalls).toBe(6);
  expect(run.value.blocks.slice(0, 2).map((block) => block.threadId)).toStrictEqual([
    "thread-1",
    "thread-2",
  ]);
});

it("a downstream worker launches with a text-only message and no attachments", async (c) => {
  // Arrange
  const f = await reportedImageWorker(c);

  // Act
  assert((await f.f.reconcileRuns()).ok);

  // Assert
  const launches = [...f.t3.launches.values()].map((launch) => launch.payload);
  expect(launches.map((launch) => launch.title)).toStrictEqual([
    "Factory #1 · 1 Entry worker",
    "Factory #1 · 2 Parallel work",
  ]);
  expect(launches[1]!.attachments).toBeUndefined();
  expect(launches[1]!.message).not.toContain("Initial prompt images");
  expect(f.t3.uploadCalls).toBe(3);
});

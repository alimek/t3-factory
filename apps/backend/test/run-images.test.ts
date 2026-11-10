import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { factoryHarness } from "./support/factory.ts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { prepared, preparedService } from "./support/prepared-runner.ts";
import {
  imageStart,
  manifestEntry,
  screenshots,
  stageImageEffects,
  stageImages,
} from "./support/run-images.ts";
import { sha256Hex, solidPng } from "./support/scenarios.ts";

const allScreenshots = [screenshots.red, screenshots.blue, screenshots.green];
const HOUR = 60 * 60_000;
const upload = (image: { data: Uint8Array }) => ({ mimeType: "image/png", data: image.data });

it("a staged image is served with its stored type and exact bytes", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open({ t3: new ControlledT3() });
  const digest = sha256Hex(screenshots.red.data);

  // Act
  const staged = await factory.stageRunImage(digest, {
    mimeType: "image/png",
    data: screenshots.red.data,
  });

  // Assert
  expect(staged).toStrictEqual({
    ok: true,
    value: { sha256: digest, mimeType: "image/png", sizeBytes: screenshots.red.data.byteLength },
  });
  const served = await factory.getRunImage(digest);
  assert(served.ok);
  expect(served.value.mimeType).toBe("image/png");
  expect(Buffer.from(served.value.data).equals(Buffer.from(screenshots.red.data))).toBe(true);
});

it("an upload whose bytes do not match the digest in its address is rejected and nothing is staged", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open({ t3: new ControlledT3() });
  const claimed = sha256Hex(screenshots.blue.data);

  // Act
  const staged = await factory.stageRunImage(claimed, {
    mimeType: "image/png",
    data: screenshots.red.data,
  });

  // Assert
  assert(!staged.ok);
  expect(staged.error.issues[0]?.code).toBe("image_digest");
  expect((await factory.getRunImageInfo(claimed)).ok).toBe(false);
});

it("an upload whose content is not the declared image type is rejected", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open({ t3: new ControlledT3() });

  // Act
  const staged = await factory.stageRunImage(sha256Hex(screenshots.red.data), {
    mimeType: "image/jpeg",
    data: screenshots.red.data,
  });

  // Assert
  assert(!staged.ok);
  expect(staged.error.issues[0]?.code).toBe("image_signature");
});

it("a staged image whose file was corrupted reads as absent and an upload of its bytes repairs it", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  const factory = await harness.open({ t3: new ControlledT3() });
  const digest = sha256Hex(screenshots.red.data);
  await stageImages(factory, [screenshots.red]);
  await writeFile(join(harness.processHome, "images", digest), "damaged");
  assert(!(await factory.getRunImageInfo(digest)).ok);

  // Act
  const staged = await factory.stageRunImage(digest, upload(screenshots.red));

  // Assert
  assert(staged.ok);
  const served = await factory.getRunImage(digest);
  assert(served.ok);
  expect(Buffer.from(served.value.data).equals(Buffer.from(screenshots.red.data))).toBe(true);
});

it("an image Factory cannot write to disk is an explicit storage error and nothing is staged", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  await writeFile(join(harness.processHome, "images"), "not a directory");
  const factory = await harness.open({ t3: new ControlledT3() });
  const digest = sha256Hex(screenshots.red.data);

  // Act
  const staged = await factory.stageRunImage(digest, upload(screenshots.red));

  // Assert
  assert(!staged.ok);
  expect(staged.error.code).toBe("internal");
  expect(staged.error.message).toContain("could not store the image on disk");
  expect((await factory.getRunImageInfo(digest)).ok).toBe(false);
});

it("an image Start freezes worker text with numbered references and lists every attached image", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);

  // Act
  const started = await f.f.startRun(imageStart(f.input));

  // Assert
  assert(started.ok, JSON.stringify(started));
  expect(started.value.input).toBe(
    "Fix the header shown in [Image 1: screenshot.png].\nKeep the footer.\n\n" +
      "Attached images: [Image 1: screenshot.png], [Image 2: screenshot.png], [Image 3: mockup.png]",
  );
});

it("an Archived Run read after restart returns its submitted segments and ordered images with duplicate names", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);
  const started = await f.f.startRun(request);
  assert(started.ok);
  assert((await f.f.archiveRun(started.value.id)).ok);
  await f.f.close();

  // Act
  const reopened = await f.h.open({ t3: f.t3 });

  // Assert
  const restored = await reopened.getRun(started.value.id);
  assert(restored.ok);
  expect(restored.value.lifecycle).toBe("archived");
  expect(restored.value.images).toStrictEqual(request.images);
  expect(restored.value.segments).toStrictEqual(request.segments);
});

it("an image Start whose image is not uploaded reports the missing digest and creates no Run", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, [screenshots.red, screenshots.green]);

  // Act
  const started = await f.f.startRun(imageStart(f.input));

  // Assert
  assert(!started.ok);
  expect(started.error.code).toBe("missing_images");
  expect(started.error.issues.map((issue) => issue.path)).toStrictEqual([
    `images.${sha256Hex(screenshots.blue.data)}`,
  ]);
  expect(await f.f.listRuns(f.project.id)).toStrictEqual({ ok: true, value: [] });
  expect(f.t3.launches.size).toBe(0);
});

it("an image Start whose declared size differs from its upload is rejected", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);
  const images = request.images.map((image, index) =>
    index === 2 ? { ...image, sizeBytes: image.sizeBytes + 1 } : image,
  );

  // Act
  const started = await f.f.startRun({ ...request, images });

  // Assert
  assert(!started.ok);
  expect(started.error.code).toBe("validation");
  expect(started.error.issues[0]).toMatchObject({ code: "image_metadata", path: "images.2" });
});

it("an image reference to an image outside the manifest is rejected", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);

  // Act
  const started = await f.f.startRun({
    ...request,
    segments: [...request.segments, { type: "image", imageId: "unknown" }],
  });

  // Assert
  assert(!started.ok);
  expect(started.error.issues[0]).toMatchObject({ code: "image_reference", path: "segments.3" });
});

it("images alone without prompt text are not a valid Start", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);

  // Act
  const started = await f.f.startRun({
    ...request,
    segments: [
      { type: "text", text: "  " },
      { type: "image", imageId: "red" },
    ],
  });

  // Assert
  assert(!started.ok);
  expect(started.error.issues[0]?.code).toBe("start_input");
});

it("an image Start is rejected when T3 cannot receive attachments and creates no work", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  f.t3.attachmentsSupported = false;

  // Act
  const started = await f.f.startRun(imageStart(f.input));

  // Assert
  assert(!started.ok);
  expect(started.error.code).toBe("validation");
  expect(started.error.issues[0]?.code).toBe("attachments_unsupported");
  expect(started.error.issues[0]?.message).toContain("update T3 or remove the images");
  expect(await f.f.listRuns(f.project.id)).toStrictEqual({ ok: true, value: [] });
});

it("an accepted image Start key reused with reordered images conflicts", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);
  assert((await f.f.startRun(request)).ok);

  // Act
  const replayed = await f.f.startRun({ ...request, images: request.images.toReversed() });

  // Assert
  assert(!replayed.ok);
  expect(replayed.error.code).toBe("conflict");
});

it("replaying an accepted image Start returns its Run although T3 no longer accepts attachments", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);
  const accepted = await f.f.startRun(request);
  assert(accepted.ok);
  f.t3.attachmentsSupported = false;

  // Act
  const replayed = await f.f.startRun(request);

  // Assert
  assert(replayed.ok);
  expect(replayed.value.id).toBe(accepted.value.id);
});

it("a text-only Start accepted in the earlier request shape recovers through prompt segments", async (c) => {
  // Arrange
  const f = await prepared(c);
  const accepted = await f.f.startRun(f.input);
  assert(accepted.ok);
  const { input, ...identity } = f.input;

  // Act
  const replayed = await f.f.startRun({
    ...identity,
    segments: [{ type: "text", text: input }],
    images: [],
  });

  // Assert
  assert(replayed.ok);
  expect(replayed.value.id).toBe(accepted.value.id);
});

it("a Start manifest may repeat a filename but not the same image bytes", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const request = imageStart(f.input);

  // Act
  const started = await f.f.startRun({
    ...request,
    images: [...request.images, manifestEntry("red-again", screenshots.red)],
  });

  // Assert
  assert(!started.ok);
  expect(started.error.issues.map((issue) => issue.code)).toStrictEqual(["image_duplicate"]);
});

it.effect(
  "an unreferenced staged image is swept 24 hours after its first upload, even when uploaded again",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const harness = yield* Effect.promise(() => factoryHarness(c));
      const factory = yield* harness.service({ t3: new ControlledT3() });
      const red = sha256Hex(screenshots.red.data);
      assert((yield* factory.stageRunImage(red, upload(screenshots.red))).ok);
      yield* TestClock.adjust(23 * HOUR);
      assert((yield* factory.stageRunImage(red, upload(screenshots.red))).ok);
      yield* TestClock.adjust(2 * HOUR);

      // Act
      const later = yield* factory.stageRunImage(
        sha256Hex(screenshots.blue.data),
        upload(screenshots.blue),
      );

      // Assert
      assert(later.ok);
      expect((yield* factory.getRunImageInfo(red)).ok).toBe(false);
    }),
);

it.effect("an image a Run retains is never swept as staging", (c) =>
  Effect.gen(function* () {
    // Arrange
    const f = yield* preparedService(c);
    yield* stageImageEffects(f.factory, allScreenshots);
    assert((yield* f.factory.startRun(imageStart(f.input))).ok);
    yield* TestClock.adjust(25 * HOUR);
    const extra = solidPng(10, 10, 10);

    // Act
    const later = yield* f.factory.stageRunImage(sha256Hex(extra), upload({ data: extra }));

    // Assert
    assert(later.ok);
    const retained = yield* f.factory.getRunImage(sha256Hex(screenshots.blue.data));
    assert(retained.ok);
    expect(Buffer.from(retained.value.data).equals(Buffer.from(screenshots.blue.data))).toBe(true);
  }),
);

it("only images whose every Run is Settled or Archived are eligible for deletion", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const archived = await f.f.startRun(imageStart(f.input));
  assert(archived.ok);
  assert((await f.f.archiveRun(archived.value.id)).ok);
  const active = await f.f.startRun({
    ...imageStart({ ...f.input, requestId: "start-two", title: "Reuse the blue screenshot" }),
    segments: [{ type: "text", text: "Compare the screenshot." }],
    images: [manifestEntry("blue", screenshots.blue)],
  });
  assert(active.ok);

  // Act
  const listed = await f.f.listEligibleRunImages("");

  // Assert
  const archivedRun = {
    id: archived.value.id,
    number: 1,
    title: "Improve search",
    lifecycle: "archived",
    project: { id: f.project.id, title: f.project.title },
  };
  expect(listed).toStrictEqual({
    ok: true,
    value: [
      {
        sha256: sha256Hex(screenshots.red.data),
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: screenshots.red.data.byteLength,
        runs: [{ ...archivedRun, ordinal: 1 }],
      },
      {
        sha256: sha256Hex(screenshots.green.data),
        name: "mockup.png",
        mimeType: "image/png",
        sizeBytes: screenshots.green.data.byteLength,
        runs: [{ ...archivedRun, ordinal: 3 }],
      },
    ],
  });
});

it("a Settled Run's image whose file is missing is not eligible for deletion", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const started = await f.f.startRun(imageStart(f.input));
  assert(started.ok);
  assert((await f.f.settleRun(started.value.id)).ok);
  await rm(join(f.h.processHome, "images", sha256Hex(screenshots.blue.data)));

  // Act
  const listed = await f.f.listEligibleRunImages("");

  // Assert
  assert(listed.ok);
  expect(listed.value.map((image) => [image.name, image.runs[0]?.lifecycle])).toStrictEqual([
    ["screenshot.png", "settled"],
    ["mockup.png", "settled"],
  ]);
  expect(listed.value[0]?.sha256).toBe(sha256Hex(screenshots.red.data));
});

it("filtering eligible images by project keeps the images its Runs used and lists every Run using them", async (c) => {
  // Arrange
  const f = await prepared(c);
  await stageImages(f.f, allScreenshots);
  const first = await f.f.startRun(imageStart(f.input));
  assert(first.ok);
  assert((await f.f.archiveRun(first.value.id)).ok);
  await mkdir(join(f.h.processHome, "second"));
  const project = await f.f.addRepository({ path: join(f.h.processHome, "second") });
  assert(project.ok);
  const second = await f.f.startRun({
    ...imageStart({
      ...f.input,
      requestId: "start-two",
      projectId: project.value.id,
      title: "Reuse the red screenshot",
      createdAt: "2026-11-07T09:00:00.000Z",
    }),
    segments: [{ type: "text", text: "Compare the screenshot." }],
    images: [manifestEntry("red", screenshots.red)],
  });
  assert(second.ok);
  assert((await f.f.settleRun(second.value.id)).ok);

  // Act
  const listed = await f.f.listEligibleRunImages(project.value.id);

  // Assert
  assert(listed.ok);
  expect(listed.value.map((image) => image.sha256)).toStrictEqual([
    sha256Hex(screenshots.red.data),
  ]);
  expect(listed.value[0]?.runs).toStrictEqual([
    {
      id: second.value.id,
      number: 2,
      title: "Reuse the red screenshot",
      lifecycle: "settled",
      project: { id: project.value.id, title: project.value.title },
      ordinal: 1,
    },
    {
      id: first.value.id,
      number: 1,
      title: "Improve search",
      lifecycle: "archived",
      project: { id: f.project.id, title: f.project.title },
      ordinal: 1,
    },
  ]);
});

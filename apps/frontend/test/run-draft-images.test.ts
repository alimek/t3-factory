import { expect, it } from "vite-plus/test";
import { ApiError } from "../src/api.ts";
import { draftTitle } from "../src/run-draft.ts";
import { composer, plain, pngFile, references, reopen } from "./support/run-draft.ts";

const savedBeforeImages = {
  current: "draft-1",
  drafts: [
    {
      id: "draft-1",
      input: "Fix the header",
      projectId: "project",
      flowId: "flow",
      createdAt: "2026-11-06T08:00:00.000Z",
      listed: true,
      submission: {
        requestId: "draft-1",
        projectId: "project",
        flowId: "flow",
        input: "Fix the header",
        title: "Fix the header",
        createdAt: "2026-11-06T08:00:00.000Z",
      },
    },
  ],
};

it("a pending Start saved before images is checked again as one text segment under the same identity", async (context) => {
  // Arrange
  const setup = composer(context);
  setup.storage.setItem("factory-run-drafts:server-a", JSON.stringify(savedBeforeImages));
  const { draft, startRun } = reopen(setup);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  expect(startRun.mock.calls[0]?.[0]).toStrictEqual({
    requestId: "draft-1",
    projectId: "project",
    flowId: "flow",
    segments: [{ type: "text", text: "Fix the header" }],
    images: [],
    title: "Fix the header",
    createdAt: "2026-11-06T08:00:00.000Z",
  });
});

it("picked images attach individually: rejected files are named and valid ones kept", async (context) => {
  // Arrange
  const { draft } = composer(context);
  const notes = new File(["plain text"], "notes.txt", { type: "text/plain" });
  const empty = new File([], "empty.png", { type: "image/png" });

  // Act
  await draft.attachImages([pngFile("header.png", 1), notes, empty, pngFile("footer.png", 2)]);

  // Assert
  const snapshot = draft.getSnapshot();
  expect(snapshot.images.map((image) => image.name)).toStrictEqual(["header.png", "footer.png"]);
  expect(snapshot.imageRejections).toStrictEqual([
    { name: "notes.txt", reason: "Only PNG, JPEG, GIF and WebP images can be attached." },
    { name: "empty.png", reason: "The file is empty." },
  ]);
});

it("identical image bytes attach once while same-named different images stay distinct", async (context) => {
  // Arrange
  const { draft } = composer(context);

  // Act
  await draft.attachImages([
    pngFile("screenshot.png", 1),
    pngFile("copy.png", 1),
    pngFile("screenshot.png", 2),
  ]);

  // Assert
  expect(draft.getSnapshot().images.map((image) => image.name)).toStrictEqual([
    "screenshot.png",
    "screenshot.png",
  ]);
});

it("pasting identical bytes references the attached image without taking another slot", async (context) => {
  // Arrange
  const { draft } = composer(context);
  await draft.attachImages([pngFile("screenshot.png", 1)]);
  const [attached] = draft.getSnapshot().images;

  // Act
  await draft.attachImages([pngFile("image.png", 1), pngFile("image.png", 2)], references);

  // Assert
  const { images, segments } = draft.getSnapshot();
  expect(images.map((image) => image.name)).toStrictEqual(["screenshot.png", "image.png"]);
  expect(segments).toStrictEqual([
    { type: "image", imageId: attached!.imageId },
    { type: "image", imageId: images[1]!.imageId },
  ]);
});

it("removing an attached image removes every reference to it and keeps the others", async (context) => {
  // Arrange
  const { draft } = composer(context);
  await draft.attachImages([pngFile("header.png", 1), pngFile("footer.png", 2)]);
  const [header, footer] = draft.getSnapshot().images.map((image) => image.imageId);
  draft.edit({
    segments: [
      { type: "text", text: "Compare " },
      { type: "image", imageId: header! },
      { type: "text", text: " with " },
      { type: "image", imageId: footer! },
      { type: "text", text: " and " },
      { type: "image", imageId: header! },
    ],
  });

  // Act
  draft.removeImage(header!);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    segments: [
      { type: "text", text: "Compare  with " },
      { type: "image", imageId: footer },
      { type: "text", text: " and " },
    ],
    images: [{ imageId: footer, name: "footer.png" }],
  });
});

it("a line holding only an image reference leaves the automatic title to the next text line", async (context) => {
  // Arrange
  const { draft } = composer(context);
  await draft.attachImages([pngFile("header.png", 1)]);
  const [header] = draft.getSnapshot().images.map((image) => image.imageId);
  draft.leave();

  // Act
  draft.edit({
    segments: [
      { type: "image", imageId: header! },
      { type: "text", text: " \nFix the header spacing\nDetails" },
    ],
  });

  // Assert
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Fix the header spacing"]);
});

it("removing an image in a stale tab keeps another tab's unresolved Start and its bytes", async (context) => {
  // Arrange
  const setup = composer(context);
  await setup.draft.attachImages([pngFile("header.png", 1)]);
  const [header] = setup.draft.getSnapshot().images.map((image) => image.imageId);
  setup.startRun.mockRejectedValueOnce(new TypeError("Response lost"));
  await reopen(setup).draft.start();

  // Act
  setup.draft.removeImage(header!);

  // Assert
  expect(reopen(setup).draft.getSnapshot()).toMatchObject({
    pending: true,
    images: [{ imageId: header, name: "header.png" }],
  });
  expect(setup.images.bytes.size).toBe(1);
});

it("an image whose bytes the browser cannot save is rejected and not referenced", async (context) => {
  // Arrange
  const { draft, images } = composer(context);
  images.store.save.mockRejectedValueOnce(new DOMException("Quota", "QuotaExceededError"));

  // Act
  await draft.attachImages([pngFile("large.png", 1), pngFile("small.png", 2)]);

  // Assert
  const snapshot = draft.getSnapshot();
  expect(snapshot.images.map((image) => image.name)).toStrictEqual(["small.png"]);
  expect(snapshot.imageRejections).toStrictEqual([
    { name: "large.png", reason: "Browser storage is full or unavailable." },
  ]);
});

it("images without prompt text keep an Untitled draft after reload", async (context) => {
  // Arrange
  const setup = composer(context);
  await setup.draft.attachImages([pngFile("header.png", 1)]);

  // Act
  setup.draft.edit({ segments: plain("") });

  // Assert
  const { draft } = reopen(setup);
  expect(draft.getSnapshot().images.map((image) => image.name)).toStrictEqual(["header.png"]);
  draft.leave();
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Untitled draft"]);
});

it("Start uploads only the images Factory lacks before sending the request", async (context) => {
  // Arrange
  const { draft, startRun, images } = composer(context);
  await draft.attachImages([pngFile("held.png", 1), pngFile("new.png", 2)]);
  const [held] = draft.getSnapshot().images;
  images.held.add(held!.sha256);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  expect(images.uploads.upload.mock.calls.map(([image]) => image.name)).toStrictEqual(["new.png"]);
  expect(startRun.mock.calls[0]?.[0].images.map((image) => image.name)).toStrictEqual([
    "held.png",
    "new.png",
  ]);
});

it("images Factory reports missing are uploaded again and the same request retried once", async (context) => {
  // Arrange
  const { draft, startRun, images } = composer(context);
  await draft.attachImages([pngFile("swept.png", 1)]);
  const [swept] = draft.getSnapshot().images;
  images.held.add(swept!.sha256);
  startRun.mockRejectedValueOnce(
    new ApiError({
      code: "missing_images",
      message: "Upload them and retry.",
      issues: [{ code: "missing_images", path: `images.${swept!.sha256}`, message: "swept.png" }],
    }),
  );
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  const runId = await draft.start();

  // Assert
  expect(runId).toBe("accepted-run");
  expect(images.uploads.upload).toHaveBeenCalledTimes(1);
  expect(startRun.mock.calls[1]?.[0]).toStrictEqual(startRun.mock.calls[0]?.[0]);
});

it("images still missing after the retry keep the draft locked with its request", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  await draft.attachImages([pngFile("swept.png", 1)]);
  const missing = new ApiError({ code: "missing_images", message: "Missing.", issues: [] });
  startRun.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);

  // Act
  await draft.start();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    pending: true,
    busy: false,
    error:
      "Factory still lacks some images of this request. Check the same request to upload them again.",
  });
});

it("a confirmed Start removes the draft's saved image bytes", async (context) => {
  // Arrange
  const { draft, startRun, images } = composer(context);
  await draft.attachImages([pngFile("header.png", 1)]);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  expect(images.bytes.size).toBe(0);
});

it("a Start whose image bytes this browser lost unlocks once Factory reports the image missing", async (context) => {
  // Arrange
  const { draft, startRun, images } = composer(context);
  await draft.attachImages([pngFile("lost.png", 1)]);
  const [lost] = draft.getSnapshot().images;
  images.bytes.clear();
  startRun.mockRejectedValueOnce(
    new ApiError({
      code: "missing_images",
      message: "Missing.",
      issues: [{ code: "missing_images", path: `images.${lost!.sha256}`, message: "lost.png" }],
    }),
  );

  // Act
  await draft.start();

  // Assert
  expect(startRun).toHaveBeenCalledTimes(1);
  expect(draft.getSnapshot()).toMatchObject({
    pending: false,
    error: "lost.png is no longer saved in this browser. Remove it and attach it again.",
  });
});

it("overlapping picks never attach more than eight images", async (context) => {
  // Arrange
  const { draft } = composer(context);
  const first = [1, 2, 3, 4, 5].map((seed) => pngFile(`first-${seed}.png`, seed));
  const second = [6, 7, 8, 9, 10].map((seed) => pngFile(`second-${seed}.png`, seed));

  // Act
  await Promise.all([draft.attachImages(first), draft.attachImages(second)]);

  // Assert
  expect(draft.getSnapshot().images).toHaveLength(8);
});

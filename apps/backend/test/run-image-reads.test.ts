import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { base64, factoryMcpClient, readRunImage, toolReply } from "./support/factory-mcp.ts";
import { preparedServer } from "./support/prepared-runner.ts";
import {
  imageRequest,
  imageStart,
  manifestEntry,
  screenshots,
  sha256Hex,
} from "./support/run-images.ts";
import {
  answeredReview,
  finishedParallelWork,
  launchedBlockId,
  launchedImageFanOut,
  reportedImageWorker,
} from "./support/run-worker.ts";

const identity = (imageId: string, ordinal: number, image: { name: string; data: Uint8Array }) => ({
  imageId,
  ordinal,
  name: image.name,
  mimeType: "image/png",
  sizeBytes: image.data.byteLength,
});

const storedImage = (processHome: string, image: { data: Uint8Array }) =>
  join(processHome, "images", sha256Hex(image.data));

it("a Block read lists the Run images in label order, duplicate names by id, without their bytes", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await client.callTool({
    name: "factory_get_block",
    arguments: { blockId: f.blockId },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(result.content).toStrictEqual([{ type: "text", text: expect.any(String) }]);
  const { inputs } = toolReply(result);
  expect(inputs.images).toStrictEqual([
    identity("red", 1, screenshots.red),
    identity("blue", 2, screenshots.blue),
    identity("green", 3, screenshots.green),
  ]);
  expect(inputs.input).toBe(
    "Fix the header shown in [Image 1: screenshot.png].\nKeep the footer.\n\nAttached images: [Image 1: screenshot.png], [Image 2: screenshot.png], [Image 3: mockup.png]",
  );
});

it("a Block read of a Run without images lists no images over the listening Factory MCP endpoint", async (c) => {
  // Arrange
  const { f, t3, mcp, input } = await preparedServer(c);
  assert((await f.startRun(input)).ok);
  assert((await f.reconcileRuns()).ok);
  const client = new Client({ name: "worker", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(mcp));
  c.onTestFinished(() => client.close());

  // Act
  const result = await client.callTool({
    name: "factory_get_block",
    arguments: { blockId: launchedBlockId(t3) },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result).inputs.images).toStrictEqual([]);
});

it("an image read returns the image's identity and exactly one image content item with its original bytes", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await readRunImage(client, f.blockId, "blue");

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result)).toStrictEqual({
    code: "IMAGE",
    image: identity("blue", 2, screenshots.blue),
  });
  expect(result.content).toStrictEqual([
    { type: "text", text: expect.any(String) },
    { type: "image", data: base64(screenshots.blue.data), mimeType: "image/png" },
  ]);
});

it("a checkout downstream worker launched without attachments reads an original Run image", async (c) => {
  // Arrange
  const f = await reportedImageWorker(c);
  assert((await f.f.reconcileRuns()).ok);
  const downstream = [...f.t3.launches.values()][1]!.payload;
  expect(downstream.attachments).toBeUndefined();
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await readRunImage(client, launchedBlockId(f.t3, "Parallel work"), "green");

  // Assert
  expect(result.isError).toBe(false);
  expect(result.content).toStrictEqual([
    { type: "text", text: expect.any(String) },
    { type: "image", data: base64(screenshots.green.data), mimeType: "image/png" },
  ]);
});

it("a worktree Block's worker launched at its first arrival after a Human step reads an original Run image", async (c) => {
  // Arrange
  const setup = await answeredReview(c, imageRequest);
  assert((await setup.f.reconcileRuns()).ok);
  const parallel = [...setup.t3.launches.values()][1]!.payload;
  expect(parallel.attachments).toBeUndefined();
  const client = await factoryMcpClient(c, setup.f);

  // Act
  const result = await readRunImage(client, launchedBlockId(setup.t3, "Parallel work"), "red");

  // Assert
  expect(result.isError).toBe(false);
  expect(result.content).toStrictEqual([
    { type: "text", text: expect.any(String) },
    { type: "image", data: base64(screenshots.red.data), mimeType: "image/png" },
  ]);
});

it("a revisited worker reads an original Run image during its queued later visit", async (c) => {
  // Arrange
  const setup = await finishedParallelWork(c, imageRequest);
  assert((await setup.f.reconcileRuns()).ok);
  const [revisit] = [...setup.t3.sends.values()].map(({ payload }) => payload);
  expect(revisit?.threadId).toBe("thread-1");
  const client = await factoryMcpClient(c, setup.f);

  // Act
  const result = await readRunImage(client, setup.entryBlockId, "blue");

  // Assert
  expect(result.isError).toBe(false);
  expect(result.content).toStrictEqual([
    { type: "text", text: expect.any(String) },
    { type: "image", data: base64(screenshots.blue.data), mimeType: "image/png" },
  ]);
});

it("another Run's image id is unknown to this Block and returns no image", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  const other = await f.f.startRun({
    ...imageStart({ ...f.input, requestId: "start-other" }),
    segments: [{ type: "text", text: "Another task." }],
    images: [manifestEntry("elsewhere", screenshots.green)],
  });
  assert(other.ok, JSON.stringify(other));
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await readRunImage(client, f.blockId, "elsewhere");

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content).toStrictEqual([{ type: "text", text: expect.any(String) }]);
  expect(toolReply(result)).toMatchObject({
    code: "UNKNOWN_IMAGE",
    next: expect.stringContaining("inputs.images"),
  });
});

it("an image read without an image id is refused with guidance", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await client.callTool({
    name: "factory_get_run_image",
    arguments: { blockId: f.blockId },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toMatchObject({
    code: "IMAGE_ID_REQUIRED",
    next: expect.stringContaining("inputs.images"),
  });
});

it("an image read with a non-string image id is refused as an invalid argument", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await client.callTool({
    name: "factory_get_run_image",
    arguments: { blockId: f.blockId, imageId: 2 },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content).toStrictEqual([{ type: "text", text: expect.any(String) }]);
  expect(toolReply(result).code).toBe("INVALID_ARGUMENT");
});

it("stored image bytes that no longer match their digest are reported unavailable for that image", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  await writeFile(storedImage(f.h.processHome, screenshots.blue), screenshots.green.data);
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await readRunImage(client, f.blockId, "blue");

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content).toStrictEqual([{ type: "text", text: expect.any(String) }]);
  expect(toolReply(result)).toMatchObject({
    code: "IMAGE_UNAVAILABLE",
    image: identity("blue", 2, screenshots.blue),
  });
});

it("stored image bytes missing from Factory storage are reported unavailable for that image", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  await rm(storedImage(f.h.processHome, screenshots.green));
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await readRunImage(client, f.blockId, "green");

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content).toStrictEqual([{ type: "text", text: expect.any(String) }]);
  expect(toolReply(result)).toMatchObject({
    code: "IMAGE_UNAVAILABLE",
    image: identity("green", 3, screenshots.green),
  });
});

it("a storage read failure is reported as a retryable failure for that image", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  const stored = storedImage(f.h.processHome, screenshots.red);
  await rm(stored);
  await mkdir(stored);
  const client = await factoryMcpClient(c, f.f);

  // Act
  const result = await readRunImage(client, f.blockId, "red");

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content).toStrictEqual([{ type: "text", text: expect.any(String) }]);
  expect(toolReply(result)).toMatchObject({
    code: "IMAGE_READ_FAILED",
    image: identity("red", 1, screenshots.red),
    next: expect.stringContaining("Retry"),
  });
});

it("repeated, lost-response and failed image reads change neither the Run nor anything in T3", async (c) => {
  // Arrange
  const f = await launchedImageFanOut(c);
  await rm(storedImage(f.h.processHome, screenshots.green));
  const blue = storedImage(f.h.processHome, screenshots.blue);
  await rm(blue);
  await mkdir(blue);
  const client = await factoryMcpClient(c, f.f);
  const lossy = await factoryMcpClient(c, f.f, { loseCallResponses: true });
  const before = await f.f.getRun(f.runId);
  const calls = { launches: f.t3.launchCalls, uploads: f.t3.uploadCalls, sends: f.t3.sends.size };

  // Act
  const results = await Promise.allSettled([
    readRunImage(client, f.blockId, "red"),
    readRunImage(client, f.blockId, "red"),
    readRunImage(lossy, f.blockId, "red"),
    readRunImage(client, f.blockId, "green"),
    readRunImage(client, f.blockId, "blue"),
    readRunImage(client, f.blockId, "purple"),
  ]);

  // Assert
  expect(results).toMatchObject([
    { status: "fulfilled", value: { isError: false } },
    { status: "fulfilled", value: { isError: false } },
    { status: "rejected" },
    { status: "fulfilled", value: { isError: true } },
    { status: "fulfilled", value: { isError: true } },
    { status: "fulfilled", value: { isError: true } },
  ]);
  expect(await f.f.getRun(f.runId)).toStrictEqual(before);
  expect({
    launches: f.t3.launchCalls,
    uploads: f.t3.uploadCalls,
    sends: f.t3.sends.size,
  }).toStrictEqual(calls);
});

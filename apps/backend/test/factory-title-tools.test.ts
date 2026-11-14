import { randomUUID } from "node:crypto";
import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { factoryMcpClient, setRunTitle, toolReply } from "./support/factory-mcp.ts";
import {
  enableRunTitles,
  titleGenerationLaunched,
  titleEvents,
  titleThreadLaunched,
  workerLaunched,
} from "./support/scenarios.ts";

/** A started Run whose title thread holds its capability, and the title thread's MCP client. */
async function titleThreadAtWork(c: Parameters<typeof prepared>[0]) {
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const thread = await titleThreadLaunched(fixture.world, fixture.input);
  return { ...fixture, ...thread, client: await factoryMcpClient(c, fixture.f) };
}

it("the first valid title applies to the Run with generated provenance, trimmed of surrounding whitespace", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "  Wyszukiwanie z rankingiem \n");

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result)).toMatchObject({
    code: "TITLE_APPLIED",
    title: "Wyszukiwanie z rankingiem",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Wyszukiwanie z rankingiem");
  expect(run.value.titleProvenance).toBe("generated");
  expect(run.value.titleGeneration).toMatchObject({
    state: "applied",
    reason: null,
    automaticTitle: "Improve search",
    generatedTitle: "Wyszukiwanie z rankingiem",
  });
});

it("applying a generated title records the Run's title events after its launch but is not Run activity", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);
  const before = await f.f.listRunNavigation();
  assert(before.ok);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "Search ranking");

  // Assert
  expect(result.isError).toBe(false);
  const after = await f.f.listRunNavigation();
  assert(after.ok);
  expect(after.value[0]?.title).toBe("Search ranking");
  expect(after.value[0]?.lastActivityAt).toBe(before.value[0]?.lastActivityAt);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(titleEvents(run.value)).toStrictEqual([
    { kind: "title-generation-started", blockId: null },
    { kind: "title-generation-applied", blockId: null },
  ]);
});

it("a title of two lines is rejected with a reason and the generation stays pending", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "Search ranking\nfor docs");

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toMatchObject({
    code: "INVALID_TITLE",
    reason: "The title has more than one line.",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Improve search");
  expect(run.value.titleGeneration?.state).toBe("pending");
});

it("a title with a control character is rejected and the generation stays pending", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "Search\tranking");

  // Assert
  expect(toolReply(result)).toMatchObject({
    code: "INVALID_TITLE",
    reason: "The title contains control characters.",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.titleGeneration?.state).toBe("pending");
});

it("a title of 121 code points is rejected rather than shortened", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "a".repeat(121));

  // Assert
  expect(toolReply(result)).toMatchObject({
    code: "INVALID_TITLE",
    reason: "The title has 121 characters; at most 120 are allowed.",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Improve search");
  expect(run.value.titleGeneration?.state).toBe("pending");
});

it("a title of 120 code points is accepted although it needs more UTF-16 units", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "🔎".repeat(120));

  // Assert
  expect(toolReply(result).code).toBe("TITLE_APPLIED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("🔎".repeat(120));
});

it("an identical title after it was applied returns the same success and writes nothing", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);
  const first = await setRunTitle(f.client, f.titleGenerationId, "Search ranking");
  assert((await f.f.renameRun(f.runId, { title: "Owner title" })).ok);

  // Act
  const repeated = await setRunTitle(f.client, f.titleGenerationId, "Search ranking");

  // Assert
  expect(repeated.isError).toBe(false);
  expect(toolReply(repeated)).toStrictEqual(toolReply(first));
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Owner title");
  expect(run.value.titleProvenance).toBe("manual");
  expect(run.value.titleGeneration).toMatchObject({
    state: "applied",
    generatedTitle: "Search ranking",
  });
});

it("a different second title is rejected and the applied title stays", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);
  expect(toolReply(await setRunTitle(f.client, f.titleGenerationId, "Search ranking")).code).toBe(
    "TITLE_APPLIED",
  );

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "Ranking search");

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result).code).toBe("TITLE_ALREADY_APPLIED");
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Search ranking");
  expect(run.value.titleGeneration?.generatedTitle).toBe("Search ranking");
});

it("a title submitted after a Rename is refused and the owner's title stays", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);
  assert((await f.f.renameRun(f.runId, { title: "Owner title" })).ok);

  // Act
  const result = await setRunTitle(f.client, f.titleGenerationId, "Search ranking");

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toMatchObject({
    code: "TITLE_GENERATION_CLOSED",
    next: "Do not submit again. End your turn.",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Owner title");
  expect(run.value.titleGeneration?.state).toBe("dropped");
});

it("an unknown title generation id is refused with repair guidance", async (c) => {
  // Arrange
  const f = await titleThreadAtWork(c);

  // Act
  const result = await setRunTitle(f.client, randomUUID(), "Search ranking");

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toStrictEqual({
    code: "UNKNOWN_TITLE_GENERATION",
    reason: "No Factory title generation has this titleGenerationId.",
    next: "Copy titleGenerationId exactly from this thread's Factory title message. Only the title thread that received it can set its Run's title; a Block id is not a titleGenerationId.",
  });
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Improve search");
  expect(run.value.titleGeneration?.state).toBe("pending");
});

it("a worker's Block id cannot set its Run's title", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const worker = await workerLaunched(fixture.world, fixture.input);
  await titleGenerationLaunched(fixture.world, worker.runId);
  const client = await factoryMcpClient(c, fixture.f);

  // Act
  const result = await setRunTitle(client, worker.blockId, "Search ranking");

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result).code).toBe("UNKNOWN_TITLE_GENERATION");
  const run = await fixture.f.getRun(worker.runId);
  assert(run.ok);
  expect(run.value.title).toBe("Improve search");
  expect(run.value.titleGeneration?.state).toBe("pending");
});

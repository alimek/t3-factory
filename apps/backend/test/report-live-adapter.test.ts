import { assert, expect, it } from "@effect/vitest";
import {
  reportReadSchema as readSchema,
  reportItem as item,
  reportPage as page,
  reportAdapter as adapter,
  paginatedReport,
  versionChangingReport,
  stabilizingChunkedReport,
  completingStreamedReport,
  inheritedReport,
  optionalMetadataReport,
} from "./support/boundaries-setup.ts";

it("report reader follows pages and exact-item continuations preserving Codex and Claude provenance", async (c) => {
  // Arrange
  const { t3, endpoint, calls, text } = await paginatedReport(c);

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(true);
  expect(result.items[0]?.text).toBe(text);
  expect(result.items[0]?.runId).toBe("exact");
  expect(result.items[0]?.complete).toBe(true);
  expect(result.items[1]?.sourceThreadId).toBe("parent");
  expect(result.items[1]?.visibility).toBe("inherited");
  expect(result.items[1]?.runId).toBe("claude-run");
  assert(calls.some((args) => args.afterPosition === 0));
  assert(calls.filter((args) => args.itemId === "codex:item").length > 2);
  assert(calls.every((args) => args.view === "activity"));
});

it("report support rejects a public schema whose read bounds cannot cover the requested page", async (c) => {
  // Arrange
  const { t3, endpoint } = await adapter(c, () => page([]), {
    ...readSchema,
    properties: { ...readSchema.properties, limit: { type: "integer", maximum: 10 } },
  });

  // Act
  const support = await t3.inspectReportSupport({ endpoint }, "codex");

  // Assert
  expect(support.supported).toBe(false);
});

it("report reader leaves item version mutation unresolved without partial text", async (c) => {
  // Arrange
  const { t3, endpoint } = await versionChangingReport(c);

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(false);
  expect(result.items[0]?.complete).toBe(false);
  expect(result.items[0]?.text).toBe(null);
  assert(result.problem);
});

it("report reader leaves truncation without continuation unresolved without partial text", async (c) => {
  // Arrange
  const { t3, endpoint } = await adapter(c, () =>
    page([
      item({
        text: "{",
        textTruncated: true,
        nextTextOffset: null,
      }),
    ]),
  );

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(false);
  expect(result.items[0]?.complete).toBe(false);
  expect(result.items[0]?.text).toBe(null);
  assert(result.problem);
});

it("report reader leaves oversized report unresolved without partial text", async (c) => {
  // Arrange
  const { t3, endpoint } = await adapter(c, () =>
    page([
      item({
        text: "x".repeat(262145),
      }),
    ]),
  );

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(false);
  expect(result.items[0]?.complete).toBe(false);
  expect(result.items[0]?.text).toBe(null);
  assert(result.problem);
});

it("report reader discards changed chunks and retrieves the complete stable item on a later observation", async (c) => {
  // Arrange
  const { t3, endpoint, text, stabilize } = await stabilizingChunkedReport(c);
  expect((await t3.readReportActivity({ endpoint }, "known")).complete).toBe(false);
  stabilize();

  // Act
  const fresh = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(fresh.complete).toBe(true);
  expect(fresh.items[0]?.text).toBe(text);
});

it("report reader revisits a streaming Claude item at the same position after completion", async (c) => {
  // Arrange
  const { t3, endpoint, complete } = await completingStreamedReport(c);
  expect((await t3.readReportActivity({ endpoint }, "known")).complete).toBe(false);
  complete();

  // Act
  const observed = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(observed.items[0]?.position).toBe(0);
  expect(observed.items[0]?.complete).toBe(true);
  expect(observed.items[0]?.status).toBe("completed");
  expect(observed.complete).toBe(true);
});

it("report reader preserves inherited metadata for consumer exclusion", async (c) => {
  // Arrange
  const { t3, endpoint, exactReads } = await inheritedReport(c);

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.items[0]).toMatchObject({ visibility: "inherited" });
  expect(exactReads()).toBe(0);
});

it("report reader treats repeated pages as incomplete coverage", async (c) => {
  // Arrange
  const { t3, endpoint } = await adapter(c, () => page([item()], { hasMore: true }));

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(false);
  assert(result.problem);
});

it("report reader treats wrong thread as incomplete coverage", async (c) => {
  // Arrange
  const { t3, endpoint } = await adapter(c, () =>
    page([], { thread: { threadId: "foreign", projectId: "neutral" } }),
  );

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(false);
  assert(result.problem);
});

it("public optional continuation metadata may be absent on complete assistant and ordinary activity items", async (c) => {
  // Arrange
  const { t3, endpoint } = await optionalMetadataReport(c);

  // Act
  const result = await t3.readReportActivity({ endpoint }, "known");

  // Assert
  expect(result.complete).toBe(true);
  expect(result.items[0]?.complete).toBe(true);
  expect(result.items.length).toBe(2);
});

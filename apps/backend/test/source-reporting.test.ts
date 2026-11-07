import { assert, expect, it } from "@effect/vitest";
import { sourceReportingFixture } from "./support/source-reporting.ts";

it("a source-installed report reaches its owning backend despite stale build output", async (context) => {
  // Arrange
  const fixture = await sourceReportingFixture(context, "stale");
  assert((await fixture.install()).ok);
  const report = await fixture.client();

  // Act
  const response = await report();

  // Assert
  expect(response.result).toStrictEqual({
    isError: false,
    content: [{ type: "text", text: '{"code":"ACCEPTED"}' }],
  });
  expect(fixture.requests).toStrictEqual([
    {
      url: "/api/runtime/report",
      header: "1",
      body: {
        arguments: { to: "finished" },
        metadata: { callId: "source-call" },
      },
    },
  ]);
});

it("source readiness offers repair for the obsolete installed bridge even when dist matches it", async (context) => {
  // Arrange
  const fixture = await sourceReportingFixture(context, "stale");
  assert((await fixture.install()).ok);
  await fixture.useStaleInstalledBridge();

  // Act
  const result = await fixture.inspect();

  // Assert
  assert(result.ok);
  expect(result.value[0]!.status).toBe("needs-attention");
  expect(result.value[0]!.actions.repair).toBe(true);
});

import { expect, it } from "@effect/vitest";
import {
  reportReadSchema as readSchema,
  reportPage as page,
  reportAdapter as adapter,
} from "./support/boundaries-setup.ts";

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

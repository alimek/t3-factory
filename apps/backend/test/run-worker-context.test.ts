import { expect, it } from "@effect/vitest";
import { directWorker } from "./support/run-worker.ts";

it("a Factory-launched worker is not authorized through the retired Run conversation context", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.context({
    arguments: {},
    metadata: { callId: "retired-context" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toStrictEqual({ code: "UNBOUND_CALLER" });
});

import { assert, expect, it } from "@effect/vitest";
import { workerFinal } from "./support/run-worker.ts";
import { longRuntimeHistory } from "./support/runtime-history.ts";

it("a native report remains attributable after a long reused conversation", async (c) => {
  // Arrange
  const { f, runId } = await longRuntimeHistory(c);

  // Act
  const result = await f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("ACCEPTED");
  const detail = await f.getRun(runId);
  assert(detail.ok);
  expect(detail.value.reports).toMatchObject([{ executionId: "execution-2", key: "final" }]);
});

it("an inherited native item cannot grant reporting authority in a long conversation", async (c) => {
  // Arrange
  const { f, runId } = await longRuntimeHistory(c, "inherited");

  // Act
  const result = await f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("FOREIGN_CALLER");
  const detail = await f.getRun(runId);
  assert(detail.ok);
  expect(detail.value.reports).toStrictEqual([]);
});

it("two native items with the same call ID cannot be collapsed into one reporting caller", async (c) => {
  // Arrange
  const { f, runId } = await longRuntimeHistory(c, "local", true);

  // Act
  const result = await f.runtime.submit(workerFinal());

  // Assert
  expect(result.code).toBe("UNBOUND_CALLER");
  const detail = await f.getRun(runId);
  assert(detail.ok);
  expect(detail.value.reports).toStrictEqual([]);
});

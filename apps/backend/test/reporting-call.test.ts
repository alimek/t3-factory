import { expect, it } from "@effect/vitest";
import { selectInFlightCall, type InFlightThread } from "../src/reporting-call.ts";
import type { RuntimeActivity } from "../src/adapters/t3.ts";

function thread(
  driver: string,
  callId: string,
  text: string,
  status = "running",
  threadId = "thread-1",
): InFlightThread {
  const page: RuntimeActivity = {
    thread: { threadId, projectId: "project-1", activeRunId: "execution-1" },
    hasMore: false,
    nextPosition: null,
    items: [
      {
        itemId: `turn-item:provider:${driver}:native-item:${callId}`,
        type: "dynamic_tool",
        status,
        runId: "execution-1",
        text,
        visibility: "local",
        sourceThreadId: threadId,
        textTruncated: false,
        nextTextOffset: null,
      },
    ],
  };
  return { threadId, projectId: "project-1", pages: [page] };
}

it("one in-flight Cursor factory call with the same arguments is the caller", () => {
  // Arrange
  const threads = [
    thread(
      "cursor",
      "call-1",
      JSON.stringify({
        toolName: "mcp__factory-runtime__factory_update_block",
        input: { to: "finished", exit: "Done", ref: "ref-1" },
      }),
    ),
  ];

  // Act
  const selected = selectInFlightCall(threads, ["mcp__factory-runtime__factory_update_block"], {
    to: "finished",
    exit: "Done",
    ref: "ref-1",
  });

  // Assert
  expect(selected).toEqual({ threadId: "thread-1", callId: "call-1" });
});

it("two in-flight factory calls with the same arguments are ambiguous", () => {
  // Arrange
  const body = JSON.stringify({
    toolName: "mcp__factory-runtime__factory_get_block",
    input: {},
  });
  const first = thread("cursor", "call-1", body);
  const second = thread("cursor", "call-2", body, "running", "thread-2");

  // Act
  const selected = selectInFlightCall(
    [first, second],
    ["mcp__factory-runtime__factory_get_block"],
    {},
  );

  // Assert
  expect(selected).toBe("ambiguous");
});

it("a completed Cursor call is not an in-flight caller", () => {
  // Arrange
  const threads = [
    thread(
      "cursor",
      "call-1",
      JSON.stringify({
        toolName: "mcp__factory-runtime__factory_get_block",
        input: { ref: "ref-1" },
        output: { code: "BLOCK" },
      }),
      "completed",
    ),
  ];

  // Act
  const selected = selectInFlightCall(threads, ["mcp__factory-runtime__factory_get_block"], {
    ref: "ref-1",
  });

  // Assert
  expect(selected).toBeUndefined();
});

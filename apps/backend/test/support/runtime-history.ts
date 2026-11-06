import type { TestContext } from "@effect/vitest";
import { directWorker } from "./run-worker.ts";
import type { RuntimeActivity, T3Endpoint } from "../../src/adapters/t3.ts";

function pagedNativeHistory(frame: RuntimeActivity, tail: RuntimeActivity["items"]) {
  const items = [
    ...Array.from({ length: 11000 }, (_, index) => ({
      itemId: `historical-${index}`,
      type: "assistant_message",
      runId: `old-execution-${index}`,
      text: "Historical conversation",
    })),
    ...tail,
  ];
  return async (_target: T3Endpoint, threadId: string, afterPosition?: number, itemId?: string) => {
    const start = afterPosition === undefined ? 0 : afterPosition + 1;
    return {
      ...frame,
      thread: { ...frame.thread, threadId },
      items: itemId
        ? items.filter((item) => item.itemId === itemId)
        : items.slice(start, start + 100),
      hasMore: !itemId && start + 100 < items.length,
      nextPosition: itemId ? null : Math.min(start + 100, items.length) - 1,
    };
  };
}

/** A worker thread with long external native history and public item/cursor lookup. */
export async function longRuntimeHistory(
  c: TestContext,
  visibility: "local" | "inherited" = "local",
  ambiguous = false,
) {
  const fixture = await directWorker(c);
  const frame = fixture.t3.runtimeActivity;
  fixture.t3.readRuntimeActivity = pagedNativeHistory(frame, [
    {
      ...frame.items[0]!,
      itemId: "turn-item:provider:codex:native-item:worker-report",
      visibility,
    },
    ...(ambiguous
      ? [{ ...frame.items[0]!, itemId: "turn-item:provider:claudeAgent:native-item:worker-report" }]
      : []),
  ]);
  return fixture;
}

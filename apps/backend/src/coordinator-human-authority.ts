import type { T3Adapter } from "./adapters/t3.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";

/** Positive public actor metadata only; forwarded text and omitted actor facts grant nothing. */
export async function nativeHumanReplies(t3: T3Adapter, run: RunRow, threadId: string) {
  const replies: { itemId: string; executionId: string }[] = [];
  let cursor: number | undefined;
  const cursors = new Set<number>();
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await t3.readRuntimeActivity(runTarget(run), threadId, cursor);
    if (page.thread.threadId !== threadId || page.thread.projectId !== run.t3_project_id) return [];
    for (const item of page.items) {
      if (isNativeUserReply(item, threadId))
        replies.push({ itemId: item.itemId, executionId: item.runId });
    }
    if (!page.hasMore) return replies;
    if (page.nextPosition === null || cursors.has(page.nextPosition)) return replies;
    cursor = page.nextPosition;
    cursors.add(cursor);
  }
  return replies;
}

function isNativeUserReply(
  item: import("./adapters/t3.ts").RuntimeActivity["items"][number],
  threadId: string,
) {
  return (
    item.createdBy === "user" &&
    item.senderThreadId === null &&
    item.visibility === "local" &&
    item.sourceThreadId === threadId &&
    item.type !== "dynamic_tool" &&
    !!item.runId
  );
}

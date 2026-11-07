import type { RuntimeActivity, T3Adapter } from "./adapters/t3.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";

type NativeWorkerTurn = {
  itemId: string;
  executionId: string;
  kind: "human-reply" | "continuation";
};

/** Native actor/type metadata grants authority; notification text is never parsed. */
export async function nativeWorkerTurns(t3: T3Adapter, run: RunRow, threadId: string) {
  const replies: NativeWorkerTurn[] = [];
  let cursor: number | undefined;
  const cursors = new Set<number>();
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await t3.readRuntimeActivity(runTarget(run), threadId, cursor);
    if (page.thread.threadId !== threadId || page.thread.projectId !== run.t3_project_id) return [];
    replies.push(...localWorkerTurns(page.items, threadId));
    if (!page.hasMore) return replies;
    if (page.nextPosition === null || cursors.has(page.nextPosition)) return replies;
    cursor = page.nextPosition;
    cursors.add(cursor);
  }
  return replies;
}

function localWorkerTurns(items: RuntimeActivity["items"], threadId: string): NativeWorkerTurn[] {
  return items
    .filter((item) => localTurnProvenance(item, threadId))
    .flatMap((item) => {
      const kind = workerTurnKind(item);
      return kind ? [{ itemId: item.itemId, executionId: item.runId, kind }] : [];
    });
}

function localTurnProvenance(item: RuntimeActivity["items"][number], threadId: string) {
  return (
    item.visibility === "local" &&
    item.sourceThreadId === threadId &&
    !item.subagentId &&
    (item.senderThreadId === undefined || item.senderThreadId === null) &&
    typeof item.runId === "string" &&
    !!item.runId
  );
}

function workerTurnKind(item: RuntimeActivity["items"][number]): NativeWorkerTurn["kind"] | null {
  if (item.createdBy === "user" && item.type !== "dynamic_tool" && item.type !== "notification")
    return "human-reply";
  if (
    item.type === "notification" &&
    (item.createdBy === null || item.createdBy === "system") &&
    (item.creationSource === null || item.creationSource === "server")
  )
    return "continuation";
  return null;
}

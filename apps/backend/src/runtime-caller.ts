import type { T3Adapter } from "./adapters/t3.ts";
import { readNativeRuntimeCall } from "./adapters/runtime-call.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
/** Both harness metadata keys, when present, must name the same non-empty call. */
export function nativeCallId(metadata: unknown): string | undefined {
  const meta = metadata as Record<string, unknown> | undefined;
  const ids = [meta?.callId, meta?.["claudecode/toolUseId"]].filter((v) => v !== undefined);
  if (!ids.length || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 1)
    return undefined;
  return ids[0] as string;
}

export async function contextCaller(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  callId: string,
): Promise<{ executionId: string; active: boolean } | { code: string } | null> {
  const nativePages = await readNativeRuntimeCall(t3, runTarget(run), threadId, callId);
  if (nativePages) return contextFromPages(nativePages, run.t3_project_id, threadId, callId);
  let cursor: number | undefined;
  const seen = new Set<number>();
  const matches: { executionId: string; active: boolean }[] = [];
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await t3.readRuntimeActivity(runTarget(run), threadId, cursor);
    const local = contextPage(page, run.t3_project_id, threadId, callId);
    if (local === "rejected") return { code: "FOREIGN_CALLER" };
    matches.push(...local);
    if (!page.hasMore) return matches.length === 1 ? matches[0]! : null;
    if (page.nextPosition === null || seen.has(page.nextPosition))
      return { code: "FOREIGN_CALLER" };
    cursor = page.nextPosition;
    seen.add(cursor);
  }
  return { code: "FOREIGN_CALLER" };
}

function contextFromPages(
  pages: readonly import("./adapters/t3.ts").RuntimeActivity[],
  projectId: string,
  threadId: string,
  callId: string,
) {
  const matches: { executionId: string; active: boolean }[] = [];
  for (const page of pages) {
    const local = contextPage(page, projectId, threadId, callId);
    if (local === "rejected") return { code: "FOREIGN_CALLER" };
    matches.push(...local);
  }
  return matches.length === 1 ? matches[0]! : null;
}

function contextItem(
  item: import("./adapters/t3.ts").RuntimeActivity["items"][number],
  threadId: string,
) {
  if (
    item.visibility !== "local" ||
    item.sourceThreadId !== threadId ||
    item.subagentId !== undefined ||
    item.textTruncated !== false ||
    (item.nextTextOffset !== null && item.nextTextOffset !== undefined) ||
    !item.text
  )
    return false;
  const event = JSON.parse(item.text);
  return ["factory-runtime.factory_context", "mcp__factory-runtime__factory_context"].includes(
    event.toolName,
  );
}

function contextPage(
  page: import("./adapters/t3.ts").RuntimeActivity,
  projectId: string,
  threadId: string,
  callId: string,
) {
  if (page.thread.threadId !== threadId || page.thread.projectId !== projectId) return "rejected";
  const matches: { executionId: string; active: boolean }[] = [];
  for (const item of page.items) {
    if (item.type !== "dynamic_tool" || !item.itemId.endsWith(":native-item:" + callId)) continue;
    if (!contextItem(item, threadId)) return "rejected";
    matches.push({ executionId: item.runId, active: item.runId === page.thread.activeRunId });
  }
  return matches;
}

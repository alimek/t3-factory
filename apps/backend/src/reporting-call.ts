import { isDeepStrictEqual } from "node:util";
import type { RuntimeActivity, T3Adapter, T3Endpoint } from "./adapters/t3.ts";
import { activityToolName } from "./activity-text.ts";
import { ACTIVITY_REPORTING_DRIVERS } from "./reporting-drivers.ts";

const MARKER = ":native-item:";
const IN_FLIGHT = new Set(["pending", "running"]);

/** Codex and Claude names, plus Grok's `server__tool` spelling of the same tools. */
export function factoryToolAliases(names: readonly string[]): readonly string[] {
  const aliases = new Set(names);
  for (const name of names) {
    const tool = name.startsWith("mcp__factory-runtime__")
      ? name.slice("mcp__factory-runtime__".length)
      : name.startsWith("factory-runtime.")
        ? name.slice("factory-runtime.".length)
        : undefined;
    if (tool) aliases.add(`factory-runtime__${tool}`);
  }
  return [...aliases];
}

export type InFlightThread = {
  readonly threadId: string;
  readonly projectId: string;
  readonly pages: readonly RuntimeActivity[];
};

type ActivityItem = RuntimeActivity["items"][number];
type FactoryBody = { readonly toolName: string; readonly input: unknown };

/** One in-flight Cursor or Grok factory call whose recorded arguments equal `args`. */
export function selectInFlightCall(
  threads: readonly InFlightThread[],
  names: readonly string[],
  args: unknown,
): { threadId: string; callId: string } | "ambiguous" | "rejected" | undefined {
  const accepted = new Set(factoryToolAliases(names));
  const matches: { threadId: string; callId: string }[] = [];
  for (const thread of threads) {
    const pageCalls = callsOnThread(thread, accepted, args);
    if (pageCalls === "rejected") return "rejected";
    matches.push(...pageCalls);
  }
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

function callsOnThread(
  thread: InFlightThread,
  names: ReadonlySet<string>,
  args: unknown,
): { threadId: string; callId: string }[] | "rejected" {
  const matches: { threadId: string; callId: string }[] = [];
  for (const page of thread.pages) {
    if (page.thread.threadId !== thread.threadId || page.thread.projectId !== thread.projectId)
      return "rejected";
    for (const item of page.items) {
      const call = inFlightCall(item, thread.threadId, names, args);
      if (call === null) return "rejected";
      if (call) matches.push({ threadId: thread.threadId, callId: call });
    }
  }
  return matches;
}

function inFlightCall(
  item: ActivityItem,
  threadId: string,
  names: ReadonlySet<string>,
  args: unknown,
): string | null | undefined {
  const driver = activityDriver(item);
  if (!driver) return undefined;
  const body = factoryBody(item, names);
  if (body === null || body === undefined) return body;
  if (item.subagentId || item.visibility !== "local" || item.sourceThreadId !== threadId)
    return null;
  if (!isDeepStrictEqual(recordedArguments(driver, body.input), args)) return undefined;
  const callId = item.itemId.slice(item.itemId.lastIndexOf(MARKER) + MARKER.length);
  return callId ? callId : null;
}

function activityDriver(item: ActivityItem): "cursor" | "grok" | undefined {
  if (item.type !== "dynamic_tool" || !IN_FLIGHT.has(item.status ?? "")) return undefined;
  const driver = /^turn-item:provider:([^:]+):native-item:/.exec(item.itemId)?.[1];
  return ACTIVITY_REPORTING_DRIVERS.find((known) => known === driver);
}

function factoryBody(
  item: ActivityItem,
  names: ReadonlySet<string>,
): FactoryBody | null | undefined {
  if (
    item.textTruncated !== false ||
    (item.nextTextOffset !== null && item.nextTextOffset !== undefined) ||
    !item.text
  ) {
    const name = activityToolName(item.text);
    if (name !== undefined && !names.has(name)) return undefined;
    return null;
  }
  let body: { toolName?: unknown; input?: unknown };
  try {
    body = JSON.parse(item.text) as { toolName?: unknown; input?: unknown };
  } catch {
    return null;
  }
  if (typeof body.toolName !== "string" || !names.has(body.toolName)) return undefined;
  return { toolName: body.toolName, input: body.input };
}

function recordedArguments(driver: "cursor" | "grok", input: unknown): unknown {
  if (driver === "cursor") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return (input as { tool_input?: unknown }).tool_input;
}

async function readThreadPages(
  t3: T3Adapter,
  target: T3Endpoint,
  threadId: string,
): Promise<readonly RuntimeActivity[] | "rejected"> {
  const pages: RuntimeActivity[] = [];
  let cursor: number | undefined;
  const seen = new Set<number>();
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await t3.readRuntimeActivity(target, threadId, cursor);
    pages.push(page);
    if (!page.hasMore) return pages;
    if (page.nextPosition === null || seen.has(page.nextPosition)) return "rejected";
    cursor = page.nextPosition;
    seen.add(cursor);
  }
  return "rejected";
}

export async function findInFlightFactoryCall(
  t3: T3Adapter,
  threads: readonly {
    threadId: string;
    projectId: string;
    target: T3Endpoint;
  }[],
  names: readonly string[],
  args: unknown,
): Promise<{ threadId: string; callId: string } | undefined> {
  const loaded: InFlightThread[] = [];
  for (const thread of threads) {
    const pages = await readThreadPages(t3, thread.target, thread.threadId);
    if (pages === "rejected") return undefined;
    loaded.push({ threadId: thread.threadId, projectId: thread.projectId, pages });
  }
  const selected = selectInFlightCall(loaded, names, args);
  return selected && selected !== "ambiguous" && selected !== "rejected" ? selected : undefined;
}

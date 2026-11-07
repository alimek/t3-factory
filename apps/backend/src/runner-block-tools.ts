import * as Effect from "effect/Effect";
import type { RunDetail } from "@t3-factory/contracts";
import type { T3Adapter } from "./adapters/t3.ts";
import { readNativeRuntimeCall } from "./adapters/runtime-call.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import type { RuntimeReply } from "./runtime-types.ts";
import { nativeCallId } from "./runtime-caller.ts";
import { runTarget } from "./runner-utils.ts";

const BLOCK_TOOLS = [
  "factory-runtime.factory_get_block",
  "mcp__factory-runtime__factory_get_block",
];
const RUN_TOOLS = ["factory-runtime.factory_get_run", "mcp__factory-runtime__factory_get_run"];
const RETRY_AFTER_MS = 500;

type ToolKind = "block" | "run";
type ToolCall = { readonly callId: string; readonly threadId: string };
type ToolProof =
  | { readonly executionId: string }
  | { readonly code: "FOREIGN_CALLER" | "INCOMPLETE_CALL_EVIDENCE" };

/** Host-owned Block and Run reads. Arguments never name a Run or Block. */
export function openBlockTools(
  database: RunnerDatabase,
  t3: T3Adapter,
  getRun: (id: string) => Effect.Effect<{ ok: true; value: RunDetail } | { ok: false }, unknown>,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  const readFactoryTool = (kind: ToolKind, input: unknown): Effect.Effect<RuntimeReply, unknown> =>
    Effect.gen(function* () {
      const call = parseToolCall(input);
      if ("code" in call) return call;
      const rows = yield* database.transaction(
        (sql) =>
          sql<{
            run_id: string;
            block_id: string;
            execution_id: string | null;
          }>`SELECT run_id,block_id,execution_id FROM run_blocks WHERE thread_id=${call.threadId}`,
      );
      if (rows.length > 1) return { code: "UNBOUND_CALLER" };
      const row = rows[0];
      if (!row) return yield* answerUnbound(kind, call);
      return yield* answerBound(
        kind,
        { runId: row.run_id, blockId: row.block_id, executionId: row.execution_id },
        call,
      );
    }).pipe(Effect.catchCause(() => Effect.succeed<RuntimeReply>({ code: "RUNTIME_UNAVAILABLE" })));

  const answerBound = (
    kind: ToolKind,
    bound: BoundWorker,
    call: ToolCall,
  ): Effect.Effect<RuntimeReply, unknown> =>
    Effect.gen(function* () {
      const run = yield* database.row(bound.runId);
      if (!run || run.context_id !== (yield* liveContextId())) return { code: "UNBOUND_CALLER" };
      const proof = yield* prove(run, call, toolNames(kind));
      if (!proof) return { code: "UNBOUND_CALLER" };
      if ("code" in proof) return proof;
      if (bound.executionId && proof.executionId !== bound.executionId)
        return { code: "UNBOUND_CALLER" };
      return yield* project(kind, bound.runId, bound.blockId);
    });

  const answerUnbound = (kind: ToolKind, call: ToolCall): Effect.Effect<RuntimeReply, unknown> =>
    Effect.gen(function* () {
      const runs = yield* database.transaction(
        (sql) =>
          sql<{
            id: string;
          }>`SELECT DISTINCT r.id FROM runs r JOIN operation_intents i ON i.run_id=r.id WHERE r.closed_at IS NULL AND i.kind='launch' AND i.state IN ('pending','reserved','uncertain')`,
      );
      let proven = false;
      for (const candidate of runs) {
        const run = yield* database.row(candidate.id);
        if (!run || run.context_id !== (yield* liveContextId())) continue;
        const proof = yield* prove(run, call, toolNames(kind));
        if (proof && "code" in proof) return proof;
        if (proof) proven = true;
      }
      return proven
        ? { code: "BINDING_PENDING", retryAfterMs: RETRY_AFTER_MS }
        : { code: "UNBOUND_CALLER" };
    });

  const prove = (run: RunRow, call: ToolCall, names: readonly string[]) =>
    Effect.tryPromise(() => proveFactoryTool(t3, run, call.threadId, call.callId, names));

  const project = (
    kind: ToolKind,
    runId: string,
    blockId: string,
  ): Effect.Effect<RuntimeReply, unknown> =>
    Effect.gen(function* () {
      const detail = yield* getRun(runId);
      if (!detail.ok) return { code: "RUNTIME_UNAVAILABLE" };
      return kind === "block" ? blockView(detail.value, blockId) : runView(detail.value);
    });

  return readFactoryTool;
}

type BoundWorker = {
  readonly runId: string;
  readonly blockId: string;
  readonly executionId: string | null;
};

function parseToolCall(input: unknown): ToolCall | RuntimeReply {
  if (!input || typeof input !== "object") return { code: "INVALID_ARGUMENT" };
  const envelope = input as Record<string, unknown>;
  const args = envelope.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)
    return { code: "INVALID_ARGUMENT" };
  const callId = nativeCallId(envelope.metadata);
  if (!callId || typeof envelope.inheritedThreadId !== "string" || !envelope.inheritedThreadId)
    return { code: "UNBOUND_CALLER" };
  return { callId, threadId: envelope.inheritedThreadId };
}

function toolNames(kind: ToolKind) {
  return kind === "block" ? BLOCK_TOOLS : RUN_TOOLS;
}

async function proveFactoryTool(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  callId: string,
  names: readonly string[],
): Promise<ToolProof | null> {
  const native = await readNativeRuntimeCall(t3, runTarget(run), threadId, callId);
  if (native) return provePages(native, run.t3_project_id, threadId, callId, names);
  const pages = [];
  let cursor: number | undefined;
  const seen = new Set<number>();
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await t3.readRuntimeActivity(runTarget(run), threadId, cursor);
    pages.push(page);
    if (!page.hasMore) return provePages(pages, run.t3_project_id, threadId, callId, names);
    if (page.nextPosition === null || seen.has(page.nextPosition)) return null;
    cursor = page.nextPosition;
    seen.add(cursor);
  }
  return null;
}

function provePages(
  pages: readonly import("./adapters/t3.ts").RuntimeActivity[],
  projectId: string,
  threadId: string,
  callId: string,
  names: readonly string[],
): ToolProof | null {
  const executions: string[] = [];
  for (const page of pages) {
    if (page.thread.threadId !== threadId || page.thread.projectId !== projectId) return null;
    for (const item of page.items) {
      const verdict = classifyCall(item, threadId, callId, names);
      if (verdict === "skip") continue;
      if (verdict !== "match") return { code: verdict };
      executions.push(item.runId);
    }
  }
  const unique = [...new Set(executions)];
  return unique.length === 1 ? { executionId: unique[0]! } : null;
}

function classifyCall(
  item: import("./adapters/t3.ts").RuntimeActivity["items"][number],
  threadId: string,
  callId: string,
  names: readonly string[],
): "skip" | "match" | "FOREIGN_CALLER" | "INCOMPLETE_CALL_EVIDENCE" {
  if (item.type !== "dynamic_tool" || !item.itemId.endsWith(`:native-item:${callId}`))
    return "skip";
  if (item.subagentId || item.visibility !== "local" || item.sourceThreadId !== threadId)
    return "FOREIGN_CALLER";
  if (
    item.textTruncated !== false ||
    (item.nextTextOffset !== null && item.nextTextOffset !== undefined) ||
    !item.text
  )
    return "INCOMPLETE_CALL_EVIDENCE";
  let toolName: unknown;
  try {
    toolName = (JSON.parse(item.text) as { toolName?: unknown }).toolName;
  } catch {
    return "INCOMPLETE_CALL_EVIDENCE";
  }
  return typeof toolName === "string" && names.includes(toolName) ? "match" : "skip";
}

function blockView(detail: RunDetail, blockId: string): RuntimeReply {
  const block = detail.blocks.find((entry) => entry.blockId === blockId);
  const graphBlock = detail.definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  if (!block || !graphBlock) return { code: "UNBOUND_CALLER" };
  const visits = detail.activations.filter((activation) => activation.blockId === blockId);
  const cause = visits[visits.length - 1]?.cause ?? "";
  const sources = new Set(
    detail.definitions.flow.graph.connections
      .filter((edge) => edge.targetBlockId === blockId)
      .map((edge) => edge.sourceBlockId),
  );
  const feedbackId = /^(?:report|human):([^/]+)/.exec(cause)?.[1];
  return {
    code: "BLOCK",
    state: block.state,
    visit: visits.length,
    reason: cause.startsWith("start:")
      ? "first"
      : cause.startsWith("human:")
        ? "Human answer"
        : "feedback",
    exits:
      graphBlock.kind === "agent"
        ? graphBlock.exits.map((exit) => ({
            id: exit.id,
            name: exit.name,
            requiresFeedback: exit.requiresFeedback,
          }))
        : [],
    inputs: {
      input: detail.input,
      results: detail.reports
        .filter((report) => sources.has(report.blockId) && report.status === "finished")
        .map((report) => ({ blockId: report.blockId, message: report.resultMessage ?? null })),
      feedback: feedbackId
        ? (detail.reports.find((report) => report.id === feedbackId)?.resultMessage ?? null)
        : null,
    },
    allowedTransitions: block.state === "working" ? ["waiting", "finished"] : [],
  };
}

function runView(detail: RunDetail): RuntimeReply {
  return {
    code: "RUN",
    number: detail.number,
    title: detail.title,
    input: detail.input,
    state: detail.closedAt
      ? (detail.outcome ?? "closed")
      : detail.stopRequestedAt
        ? "stopping"
        : "running",
    blocks: detail.blocks.map((block) => ({
      blockId: block.blockId,
      name: block.name,
      state: block.state,
      result:
        [...detail.reports].reverse().find((report) => report.blockId === block.blockId)
          ?.resultMessage ?? null,
    })),
  };
}

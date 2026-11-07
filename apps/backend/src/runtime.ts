import { nativeCallId } from "./runtime-caller.ts";
import { factoryToolAliases, findInFlightFactoryCall } from "./reporting-call.ts";
import * as Effect from "effect/Effect";
import type { RuntimeActivity, T3Adapter } from "./adapters/t3.ts";
import { readNativeRuntimeCall } from "./adapters/runtime-call.ts";
import type { RuntimeBinding, RuntimeReply, RuntimeReport } from "./runtime-types.ts";
const UPDATE_FIELDS = ["to", "exit", "message"];
const REPORT_TOOL_NAMES = factoryToolAliases([
  "factory-runtime.factory_update_block",
  "mcp__factory-runtime__factory_update_block",
]);

/** A factory_update_block call as forwarded by the stdio runtime, before caller correlation. */
interface ReportCall {
  readonly report: RuntimeReport;
  /** The harness's native call ID (`callId` or `claudecode/toolUseId`). */
  readonly callId: string | undefined;
  /** Any truthy hint restricts candidates; only a string names a thread. */
  readonly inheritedThread: unknown;
  /** Original tool arguments, including `ref`, for harnesses that omit a call id. */
  readonly args: unknown;
}
/** One public activity item proving the native call ran in the candidate's thread. */
interface CallerMatch {
  readonly binding: RuntimeBinding;
  readonly registered?: RuntimeBinding;
  readonly active: boolean;
}

/** The model names only the transition. Factory stores that transition as the report identity. */
function blockUpdate(args: unknown): RuntimeReport | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const fields = { ...(args as Record<string, unknown>) };
  if ("ref" in fields) {
    if (typeof fields.ref !== "string" || !fields.ref) return undefined;
    delete fields.ref;
  }
  if (!Object.keys(fields).every((key) => UPDATE_FIELDS.includes(key))) return undefined;
  if (fields.to !== "waiting" && fields.to !== "finished") return undefined;
  if ("exit" in fields && typeof fields.exit !== "string") return undefined;
  if ("message" in fields && typeof fields.message !== "string") return undefined;
  return {
    key: fields.to,
    status: fields.to,
    ...("exit" in fields ? { exit: fields.exit as string } : {}),
    ...("message" in fields ? { message: fields.message as string } : {}),
  };
}

function parseReportCall(input: unknown): ReportCall | RuntimeReply {
  if (!input || typeof input !== "object") return { code: "INVALID_ARGUMENT" };
  const envelope = input as Record<string, unknown>;
  const report = blockUpdate(envelope.arguments);
  if (!report) return { code: "INVALID_ARGUMENT" };
  const callId = nativeCallId(envelope.metadata);
  return { report, callId, inheritedThread: envelope.inheritedThreadId, args: envelope.arguments };
}

/** Undefined when the item is the report tool; otherwise the rejection for a mismatched call. */
function reportToolRejection(item: RuntimeActivity["items"][number]): RuntimeReply | undefined {
  let event: { toolName?: unknown };
  try {
    event = JSON.parse(item.text ?? "") as { toolName?: unknown };
  } catch {
    return { code: "UNBOUND_CALLER" };
  }
  if (typeof event.toolName !== "string" || !REPORT_TOOL_NAMES.includes(event.toolName))
    return { code: "TOOL_MISMATCH" };
  return undefined;
}

function callProvenanceRejection(
  binding: RuntimeBinding,
  item: RuntimeActivity["items"][number],
): RuntimeReply | undefined {
  if (item.visibility !== "local" || item.sourceThreadId !== binding.threadId || item.subagentId)
    return { code: "FOREIGN_CALLER" };
  if (
    item.textTruncated !== false ||
    (item.nextTextOffset !== null && item.nextTextOffset !== undefined) ||
    item.text === null
  )
    return { code: "INCOMPLETE_CALL_EVIDENCE" };
  return undefined;
}

/** Backend-owned binding registry. Runs must restore bindings on startup, and remove on closure.
 * No dispatch here: Runner consumes the bound report and owns its transaction/gate/dedup. */
export function createRuntime(
  t3: T3Adapter,
  context: () => Effect.Effect<string | null, unknown>,
  consume?: (
    binding: RuntimeBinding,
    report: RuntimeReport,
    retryOnly?: boolean,
  ) => Effect.Effect<RuntimeReply, unknown>,
  refresh?: (binding: RuntimeBinding) => Effect.Effect<void, unknown>,
  isClosedThread?: (threadId: string) => Effect.Effect<boolean, unknown>,
  reportBindings?: (
    key: string,
    threadId?: string,
    discover?: boolean,
  ) => Effect.Effect<readonly RuntimeBinding[], unknown>,
  contextCall?: (
    input: unknown,
  ) => Effect.Effect<import("./runtime-types.ts").RuntimeContextReply, unknown>,
  readTool?: (kind: "block" | "run", input: unknown) => Effect.Effect<RuntimeReply, unknown>,
) {
  const bindings = new Map<string, RuntimeBinding>();

  /** Collects this page's items for the native call; a rejection stops correlation. */
  function collectPageMatches(
    page: RuntimeActivity,
    binding: RuntimeBinding,
    wasRegistered: boolean,
    callId: string,
    matches: CallerMatch[],
  ): RuntimeReply | undefined {
    if (page.thread.threadId !== binding.threadId) return { code: "FOREIGN_CALLER" };
    if (page.thread.projectId !== binding.projectId) return { code: "UNBOUND_CALLER" };
    for (const item of page.items) {
      if (item.type !== "dynamic_tool" || !item.itemId.endsWith(":native-item:" + callId)) continue;
      const provenance = callProvenanceRejection(binding, item);
      if (provenance) return provenance;
      const rejection = reportToolRejection(item);
      if (rejection) return rejection;
      matches.push({
        binding: { ...binding, runId: item.runId },
        ...(wasRegistered ? { registered: binding } : {}),
        active: item.runId === binding.runId && page.thread.activeRunId === binding.runId,
      });
    }
    return undefined;
  }

  const scanActivity = Effect.fn(function* (
    binding: RuntimeBinding,
    wasRegistered: boolean,
    callId: string,
    matches: CallerMatch[],
  ) {
    const nativePages = yield* boundary(() =>
      readNativeRuntimeCall(t3, { endpoint: binding.endpoint }, binding.threadId, callId),
    );
    if (nativePages) {
      for (const page of nativePages) {
        const rejection = collectPageMatches(page, binding, wasRegistered, callId, matches);
        if (rejection) return rejection;
      }
      return undefined;
    }
    let cursor: number | undefined;
    const seen = new Set<number>();
    while (true) {
      const page = yield* boundary(() =>
        t3.readRuntimeActivity({ endpoint: binding.endpoint }, binding.threadId, cursor),
      );
      const rejection = collectPageMatches(page, binding, wasRegistered, callId, matches);
      if (rejection) return rejection;
      if (!page.hasMore) return undefined;
      if (page.nextPosition === null || seen.has(page.nextPosition) || seen.size >= 100)
        return { code: "UNBOUND_CALLER" };
      cursor = page.nextPosition;
      seen.add(cursor);
    }
  });

  const correlateCandidate = Effect.fn(function* (
    candidate: RuntimeBinding,
    call: ReportCall,
    matches: CallerMatch[],
  ) {
    if (call.inheritedThread && call.inheritedThread !== candidate.threadId) return undefined;
    const registered = bindings.get(candidate.threadId);
    if (registered && refresh) yield* refresh(registered);
    const binding = bindings.get(candidate.threadId) ?? candidate;
    if (binding.contextId !== (yield* context())) return undefined;
    if (call.inheritedThread && call.inheritedThread !== binding.threadId) return undefined;
    if (!call.callId) return { code: "UNBOUND_CALLER" };
    return yield* scanActivity(binding, registered !== undefined, call.callId, matches);
  });

  const discoverCaller = Effect.fn(function* (
    call: ReportCall,
    threadId: string | undefined,
    known: Map<string, RuntimeBinding>,
    matches: CallerMatch[],
  ) {
    if (!reportBindings) return;
    yield* reportBindings(call.report.key, threadId, true);
    for (const candidate of bindings.values()) {
      if (known.has(candidate.threadId)) continue;
      const rejection = yield* correlateCandidate(candidate, call, matches);
      if (rejection) return rejection;
    }
    return undefined;
  });

  const withActivityCall = Effect.fn(function* (
    call: ReportCall,
    candidates: ReadonlyMap<string, RuntimeBinding>,
  ) {
    if (call.callId !== undefined) return call;
    const hint = typeof call.inheritedThread === "string" ? call.inheritedThread : undefined;
    const pool = [...candidates.values()].filter(
      (candidate) => hint === undefined || candidate.threadId === hint,
    );
    const located = yield* boundary(() =>
      findInFlightFactoryCall(
        t3,
        pool.map((candidate) => ({
          threadId: candidate.threadId,
          projectId: candidate.projectId,
          target: { endpoint: candidate.endpoint },
        })),
        REPORT_TOOL_NAMES,
        call.args,
      ),
    );
    if (!located) return { code: "UNBOUND_CALLER" as const };
    return { ...call, callId: located.callId, inheritedThread: located.threadId };
  });

  /** Requires exactly one public activity item for the native call across all candidates. */
  const correlate = Effect.fn(function* (call: ReportCall) {
    const inheritedThreadId =
      typeof call.inheritedThread === "string" ? call.inheritedThread : undefined;
    // Retained report metadata supplies candidates after unbinding. It is not
    // caller proof: still correlate the native call ID to its exact execution.
    const historical = reportBindings
      ? yield* reportBindings(call.report.key, inheritedThreadId)
      : [];
    const candidates = new Map(historical.map((b) => [b.threadId, b]));
    for (const b of bindings.values()) candidates.set(b.threadId, b);
    const locatedCall = yield* withActivityCall(call, candidates);
    if ("code" in locatedCall) return locatedCall;
    if (
      inheritedThreadId !== undefined &&
      !candidates.has(inheritedThreadId) &&
      isClosedThread &&
      (yield* isClosedThread(inheritedThreadId))
    )
      return { code: "RUN_CLOSED" };
    const matches: CallerMatch[] = [];
    for (const candidate of candidates.values()) {
      const rejection = yield* correlateCandidate(candidate, locatedCall, matches);
      if (rejection) return rejection;
    }
    if (!matches.length) {
      const rejection = yield* discoverCaller(
        locatedCall,
        typeof locatedCall.inheritedThread === "string" ? locatedCall.inheritedThread : undefined,
        candidates,
        matches,
      );
      if (rejection) return rejection;
    }

    return matches.length === 1 ? matches[0]! : { code: "UNBOUND_CALLER" };
  });

  const forwardReport = Effect.fn(function* (
    report: RuntimeReport,
    { binding, registered, active }: CallerMatch,
  ) {
    if (
      (registered && bindings.get(binding.threadId) !== registered) ||
      binding.contextId !== (yield* context())
    )
      return { code: "UNBOUND_CALLER" };
    return consume ? yield* consume(binding, report, !active) : { code: "RUNNER_UNAVAILABLE" };
  });

  return {
    context: (input: unknown) =>
      contextCall ? contextCall(input) : Effect.succeed({ code: "RUNNER_UNAVAILABLE" }),
    block: (input: unknown) =>
      readTool ? readTool("block", input) : Effect.succeed({ code: "RUNNER_UNAVAILABLE" }),
    run: (input: unknown) =>
      readTool ? readTool("run", input) : Effect.succeed({ code: "RUNNER_UNAVAILABLE" }),
    bind(binding: RuntimeBinding) {
      const previous = bindings.get(binding.threadId);
      // An unchanged observation must not invalidate another in-progress correlation.
      if (
        previous &&
        previous.runId === binding.runId &&
        previous.projectId === binding.projectId &&
        previous.endpoint === binding.endpoint &&
        previous.contextId === binding.contextId &&
        previous.factoryRunId === binding.factoryRunId &&
        previous.blockId === binding.blockId
      )
        return;
      bindings.set(binding.threadId, { ...binding });
    },
    unbind(threadId: string) {
      bindings.delete(threadId);
    },
    submit: Effect.fn(function* (input: unknown) {
      const call = parseReportCall(input);
      if ("code" in call) return call;
      return yield* Effect.gen(function* () {
        const match = yield* correlate(call);
        return "code" in match ? match : yield* forwardReport(call.report, match);
      }).pipe(Effect.catchCause(() => Effect.succeed({ code: "RUNTIME_UNAVAILABLE" })));
    }),
  };
}

const boundary = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: operation, catch: (error) => error });

/** The runtime boundary as composed into FactoryService. */
export type RuntimeReports = ReturnType<typeof createRuntime>;

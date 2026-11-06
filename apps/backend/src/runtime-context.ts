import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import type { RuntimeContextReply } from "./runtime-types.ts";
import type { openRootCommands } from "./run-coordinator-commands.ts";
import type { openRunnerObservation } from "./runner-observation.ts";
import { nativeCallId, contextCaller } from "./runtime-caller.ts";
import { runTarget } from "./runner-utils.ts";

/** Host-owned caller correlation; arguments contain no Run, Block or bearer authority. */
export function openRuntimeContext(
  database: RunnerDatabase,
  t3: T3Adapter,
  rootCommands: ReturnType<typeof openRootCommands>,
  observeWorker: ReturnType<typeof openRunnerObservation>["observe"],
  liveContextId: () => Effect.Effect<string | null, unknown>,
  getRun: (
    id: string,
  ) => Effect.Effect<
    import("@t3-factory/contracts").Result<import("@t3-factory/contracts").RunDetail>,
    unknown
  >,
) {
  const candidatesForRoot = Effect.fn(function* (
    run: RunRow,
    rootThreadId: string,
    { callId, inheritedThreadId }: ContextCall,
  ) {
    const matches: ContextCaller[] = [];
    const candidates = new Set([rootThreadId]);
    if (inheritedThreadId !== rootThreadId) {
      const descendants = yield* Effect.tryPromise(() =>
        t3.readDescendants(runTarget(run), rootThreadId),
      );
      const saved = yield* rootCommands.commands(run.id);
      for (const threadId of [
        ...saved.flatMap((c) => (c.thread_id ? [c.thread_id] : [])),
        ...descendants.descendants.map((d) => d.threadId),
      ])
        candidates.add(threadId);
    }
    for (const threadId of candidates) {
      if (inheritedThreadId && inheritedThreadId !== threadId) continue;
      const proof = yield* Effect.tryPromise(() => contextCaller(t3, run, threadId, callId));
      if (proof && "code" in proof) return proof;
      if (proof) matches.push({ run, threadId, executionId: proof.executionId, rootThreadId });
    }
    return matches;
  });
  const findCaller = Effect.fn(function* (call: ContextCall) {
    const rootHint = typeof call.inheritedThreadId === "string" ? call.inheritedThreadId : null;
    const ids = yield* database.transaction(
      (sql) =>
        sql<{
          run_id: string;
          thread_id: string;
        }>`SELECT c.run_id,c.thread_id FROM run_coordinators c JOIN runs r ON r.id=c.run_id WHERE c.instruction_version=1 AND c.state='acknowledged' AND ((r.closed_at IS NULL AND r.gate_open=1) OR c.thread_id=${rootHint})`,
    );
    const matches: { run: RunRow; threadId: string; executionId: string; rootThreadId: string }[] =
      [];
    for (const root of ids) {
      const run = yield* database.row(root.run_id);
      if (!run || run.context_id !== (yield* liveContextId())) continue;
      const local = yield* candidatesForRoot(run, root.thread_id, call);
      if ("code" in local) return local;
      matches.push(...local);
    }
    return matches.length === 1 ? matches[0]! : { code: "UNBOUND_CALLER" };
  });
  const workerContext = Effect.fn(function* (
    caller: ContextCaller,
  ): Effect.fn.Return<RuntimeContextReply, unknown> {
    yield* rootCommands.observe(caller.run);
    const [block] = yield* database.transaction(
      (sql) =>
        sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${caller.run.id} AND thread_id=${caller.threadId}`,
    );
    if (block && caller.run.gate_open && !caller.run.closed_at)
      yield* observeWorker(caller.run, block, yield* liveContextId());
    const [worker] = yield* database.transaction(
      (sql) =>
        sql<{
          activation_id: string;
        }>`SELECT e.activation_id FROM run_executions e JOIN run_worker_activations w ON w.activation_id=e.activation_id AND w.binding_id=e.binding_id WHERE e.run_id=${caller.run.id} AND e.thread_id=${caller.threadId} AND e.execution_id=${caller.executionId}`,
    );
    return worker
      ? { code: "CONTEXT", role: "worker", activationId: worker.activation_id }
      : { code: "BINDING_PENDING" };
  });
  const context = Effect.fn(function* (
    input: unknown,
  ): Effect.fn.Return<RuntimeContextReply, unknown> {
    const call = contextEnvelope(input);
    if ("code" in call) return call;
    const caller = yield* findCaller(call);
    if ("code" in caller) return caller;
    if (caller.threadId !== caller.rootThreadId) return yield* workerContext(caller);
    const detail = yield* getRun(caller.run.id);
    return detail.ok
      ? { code: "CONTEXT", role: "run-coordinator", run: runContext(detail.value) }
      : { code: "RUNTIME_UNAVAILABLE" };
  });
  return (input: unknown) =>
    context(input).pipe(
      Effect.catchCause(() => Effect.succeed<RuntimeContextReply>({ code: "RUNTIME_UNAVAILABLE" })),
    );
}

type ContextCaller = { run: RunRow; threadId: string; executionId: string; rootThreadId: string };
type ContextCall = { callId: string; inheritedThreadId: unknown };
function contextEnvelope(input: unknown): ContextCall | RuntimeContextReply {
  if (!input || typeof input !== "object") return { code: "INVALID_ARGUMENT" };
  const envelope = input as Record<string, unknown>;
  if (
    !envelope.arguments ||
    typeof envelope.arguments !== "object" ||
    Array.isArray(envelope.arguments) ||
    Object.keys(envelope.arguments).length
  )
    return { code: "INVALID_ARGUMENT" };
  const callId = nativeCallId(envelope.metadata);
  if (!callId || (envelope.inheritedThreadId && typeof envelope.inheritedThreadId !== "string"))
    return { code: "UNBOUND_CALLER" };
  return { callId, inheritedThreadId: envelope.inheritedThreadId };
}

function runContext(
  detail: import("@t3-factory/contracts").RunDetail,
): import("./runtime-types.ts").RunContext {
  return {
    id: detail.id,
    input: detail.input,
    gateOpen: detail.gateOpen,
    closedAt: detail.closedAt,
    outcome: detail.outcome,
    stopRequestedAt: detail.stopRequestedAt,
    snapshot: { flow: detail.snapshot.flow },
    blocks: detail.blocks.map(({ blockId, name, state, problem, freshness }) => ({
      blockId,
      name,
      state,
      problem,
      freshness,
    })),
    results: detail.reports.map(({ blockId, exitId, resultMessage }) => ({
      blockId,
      exitId,
      message: resultMessage ?? null,
    })),
    questions: detail.attention
      .filter((a) => !a.settledAt)
      .map(({ id, blockId, message }) => ({ id, blockId, message })),
  };
}

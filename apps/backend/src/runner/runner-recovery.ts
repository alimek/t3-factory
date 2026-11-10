import { recoverOperation } from "./runner-effects.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import type { Delivery, RunStore } from "./run-store/run-store.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { readWorkerThread } from "./worker-thread.ts";
import { failure } from "../result.ts";
/** Request report assesses a finished worker thread whose latest run is the one it was asked for. */
function recoveryReady(t3: T3Adapter, run: RunRow, threadId: string, executionId: string) {
  return Effect.tryPromise(async () => {
    const worker = await readWorkerThread(t3, run, threadId);
    return (
      worker.finished &&
      worker.latest?.runId === executionId &&
      worker.latest.status === "completed"
    );
  });
}
export function openRunnerRecovery(
  store: RunStore,
  lifecycle: RunnerLifecycle,
  t3: T3Adapter,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  function requestReport(runId: string, input: unknown): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
      if (
        typeof input !== "object" ||
        input === null ||
        !("blockId" in input) ||
        typeof input.blockId !== "string" ||
        !input.blockId
      )
        return failure("validation", "Choose the Block to request a report from.");
      const blockId = input.blockId;
      const detail = yield* lifecycle.getRun(runId);
      if (!detail.ok) return detail;
      const b = detail.value.blocks.find((block) => block.blockId === blockId);
      if (!b) return failure("not_found", "This Block is not part of the Run.");
      if (
        detail.value.recoveries.some(
          (r) => r.blockId === blockId && r.sourceExecutionId === b.executionId,
        )
      )
        return detail;
      const visit = detail.value.activations.filter((a) => a.blockId === blockId).at(-1);
      const current = yield* store.readRun(runId);
      if (
        !current ||
        !b.threadId ||
        !b.executionId ||
        !visit ||
        detail.value.reports.some((r) => r.activationId === visit.id && r.status === "finished")
      )
        return failure(
          "conflict",
          "Request report needs an Agent Block with a worker thread and no finished result for its current visit. Refresh the Run.",
        );
      const threadId = b.threadId,
        executionId = b.executionId;
      const preflight = yield* recoverOperation(
        Effect.gen(function* () {
          if (
            (yield* liveContextId()) !== current.context_id ||
            !(yield* recoveryReady(t3, current, threadId, executionId))
          )
            return failure(
              "conflict",
              "Request report needs the worker thread finished in T3 with no run newer than the one Factory observed.",
            );
          return { ok: true as const, value: undefined };
        }),
        () =>
          Effect.succeed(
            failure(
              "conflict",
              "The worker thread cannot be read from T3. Refresh before requesting a report.",
            ),
          ),
      );
      if (!preflight.ok) return preflight;
      const accepted = yield* store.acceptRequestReport(current, {
        blockId,
        threadId,
        executionId,
        activationId: visit.id,
      });
      if (!accepted.ok) return accepted;
      yield* lifecycle.drive(current.id, "dispatch");
      return yield* lifecycle.getRun(current.id);
    });
  }
  return { requestReport };
}
export function recoveryDispatchGeneration(
  store: RunStore,
  t3: T3Adapter,
  runRow: RunRow,
  intent: Delivery,
) {
  return Effect.gen(function* () {
    if (!intent.cause.startsWith("recovery:") || intent.state !== "pending") return undefined;
    const current = yield* store.readRun(runRow.id);
    if (!current) return null;
    const target = JSON.parse(intent.target_json) as {
      threadId: string;
    };
    const recovery = yield* store.recoverySource(intent.id);
    if (
      !recovery ||
      !(yield* recoveryReady(t3, current, target.threadId, recovery.source_execution_id))
    ) {
      yield* store.noteUnresolved(
        intent,
        "Recovery target has new activity or pending attention; the accepted request remains unsent.",
      );
      return null;
    }
    return current.generation;
  });
}

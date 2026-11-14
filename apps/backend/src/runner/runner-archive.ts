import { recoverOperation } from "./runner-effects.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import type { RunStore } from "./run-store/run-store.ts";
import { changeLifecycle } from "./run-lifecycle.ts";
import type { RunnerLifecycle } from "./runner-types.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";

export function openRunnerArchive(
  store: RunStore,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  /** One best-effort interrupt per worker thread, sent once after Archive; T3 stops the thread
   * and its delegated work. Factory neither waits for nor confirms termination. */
  function interruptWorkerThreads(id: string) {
    return recoverOperation(
      Effect.gen(function* () {
        const run = yield* store.readRun(id);
        if (!run || (yield* liveContextId()) !== run.context_id) return;
        const threads = yield* store.boundWorkers(id);
        if (!threads.length) return;
        const support = yield* Effect.tryPromise(() => t3.inspectStopSupport(runTarget(run)));
        if (!support.supported) return;
        for (const { thread_id: threadId } of threads)
          yield* recoverOperation(
            Effect.tryPromise(() =>
              t3.stopThread(runTarget(run), {
                threadId,
                clientRequestId: fingerprint(`${id}:archive:${threadId}`),
              }),
            ),
            () => Effect.void,
          );
      }),
      () => Effect.void,
    );
  }

  /** Archive is final and completes in the acceptance lane; interruption follows in the background,
   * only when this call archived the Run. `requestId` attributes the Archive to that request. */
  function archiveRun(id: string, requestId?: string): Effect.Effect<Result<RunDetail>, unknown> {
    return changeLifecycle(lifecycle, id, store.archive(id, requestId), interruptWorkerThreads(id));
  }
  return { archiveRun };
}

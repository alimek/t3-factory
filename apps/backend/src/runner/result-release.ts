import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import type { RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";
import { readWorkerThread } from "./worker-thread.ts";

/** Asks the Handoff release rule for one Final result version. The Run store answers what the
 * release still waits for and applies the local part; this reads the T3 part, whether the source
 * worker thread is finished, at `run`'s generation. A replaced version is never released. */
export function releaseResult(store: RunStore, t3: T3Adapter, run: RunRow, reportId: string) {
  return Effect.gen(function* () {
    const wait = yield* store.releaseWait(run, reportId);
    if (wait.released) return true;
    const threadId = wait.sourceThreadId;
    if (!threadId) return false;
    const worker = yield* Effect.tryPromise(() => readWorkerThread(t3, run, threadId));
    if (!worker.finished) return false;
    return yield* store.releaseFinalResult(run, reportId);
  });
}

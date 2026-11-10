import { releaseResult } from "./result-release.ts";
import { readWorkerThread } from "./worker-thread.ts";
import * as Effect from "effect/Effect";
import type { ExecutionObservation, T3Adapter } from "./adapters/t3.ts";
import type { Delivery, Handoff, RunStore } from "./runner/run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";

/** A thread T3 shows with no run and no native request has no earlier turn to wait for, as an idle
 * worker prepared before Factory stopped preparing them, whose first visit is a queued send. */
const neverRan = (thread: ExecutionObservation) =>
  !thread.activeRunId &&
  !thread.latestRunId &&
  thread.recentRuns.length === 0 &&
  thread.pendingRequestCount === 0;

/** A released worker result (or a durable Human answer) and, for a revisit, a finished target thread. */
function explicitSourceReleaseGeneration(
  store: RunStore,
  t3: T3Adapter,
  run: RunRow,
  record: Handoff | Delivery,
) {
  return Effect.gen(function* () {
    const current = yield* store.readRun(run.id);
    if (!current) return null;
    if (record.report_id) {
      if (!(yield* releaseResult(store, t3, current, record.report_id))) return null;
    } else if (!(yield* store.humanSourceAnswered(run.id, record))) return null;
    if (record.kind === "send") {
      const { threadId } = JSON.parse(record.target_json) as { threadId: string };
      const target = yield* Effect.tryPromise(() => readWorkerThread(t3, current, threadId));
      if (!target.finished && !neverRan(target.thread)) return null;
    }
    return current.generation;
  });
}

/** Converts a pending Human handoff after optional explicit source release; no-op when held. */
export function activatePendingHumanHandoff(
  store: RunStore,
  t3: T3Adapter,
  runRow: RunRow,
  handoff: Handoff,
) {
  return Effect.gen(function* () {
    const generation = handoff.report_id
      ? yield* explicitSourceReleaseGeneration(store, t3, runRow, handoff)
      : undefined;
    if (generation === null) return;
    yield* store.handoffToHumanOccurrence(runRow, handoff, generation);
  });
}

/** Reserves a pending send from a Handoff after explicit source release; false when held or
 * guards fail. */
export function reservePendingExplicitHandoff(
  store: RunStore,
  t3: T3Adapter,
  runRow: RunRow,
  delivery: Delivery,
  retryScope: string | null,
) {
  return Effect.gen(function* () {
    const generation = yield* explicitSourceReleaseGeneration(store, t3, runRow, delivery);
    if (generation === null) return false;
    return yield* store.reserveDelivery(runRow, delivery, retryScope, generation);
  });
}

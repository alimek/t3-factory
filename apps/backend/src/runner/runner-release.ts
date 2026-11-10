import { releaseResult } from "./result-release.ts";
import { readWorkerThread } from "./worker-thread.ts";
import * as Effect from "effect/Effect";
import type { ExecutionObservation, T3Adapter } from "../adapters/t3.ts";
import type { Delivery, Handoff, RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";

/** A thread T3 shows with no run and no native request has no earlier turn to wait for, as an idle
 * worker prepared before Factory stopped preparing them, whose first visit is a queued send. */
const neverRan = (thread: ExecutionObservation) =>
  !thread.activeRunId &&
  !thread.latestRunId &&
  thread.recentRuns.length === 0 &&
  thread.pendingRequestCount === 0;

/** A released worker result (or a durable Human answer, Wait forwarding or pass-through) and, for a
 * send, a finished target thread that owes no other Block's task. */
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
    } else if (!(yield* store.directSourceReleased(run.id, record))) return null;
    if (record.kind === "send") {
      const { threadId } = JSON.parse(record.target_json) as { threadId: string };
      if (yield* store.threadOwesOtherTask(run.id, threadId, record.block_id)) return null;
      const target = yield* Effect.tryPromise(() => readWorkerThread(t3, current, threadId));
      if (!target.finished && !neverRan(target.thread)) return null;
    }
    return current.generation;
  });
}

/** The generation at which a pending Handoff to a Human step or Wait may arrive: a Final result's
 * release must be read first; a Human answer or Wait forwarding already released it. Null while
 * held. */
function arrivalGeneration(store: RunStore, t3: T3Adapter, runRow: RunRow, handoff: Handoff) {
  return handoff.report_id
    ? explicitSourceReleaseGeneration(store, t3, runRow, handoff)
    : Effect.succeed(undefined);
}

/** Converts a pending Human handoff after optional explicit source release; no-op when held. */
export function activatePendingHumanHandoff(
  store: RunStore,
  t3: T3Adapter,
  runRow: RunRow,
  handoff: Handoff,
) {
  return Effect.gen(function* () {
    const generation = yield* arrivalGeneration(store, t3, runRow, handoff);
    if (generation === null) return;
    yield* store.handoffToHumanOccurrence(runRow, handoff, generation);
  });
}

/** Records a pending Handoff to a Wait as its arrival once its source is released, answering the
 * arrival to schedule; undefined while held or when the guards fail. */
export function activatePendingWaitHandoff(
  store: RunStore,
  t3: T3Adapter,
  runRow: RunRow,
  handoff: Handoff,
) {
  return Effect.gen(function* () {
    const generation = yield* arrivalGeneration(store, t3, runRow, handoff);
    if (generation === null) return undefined;
    return yield* store.handoffToWaitArrival(runRow, handoff, generation);
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

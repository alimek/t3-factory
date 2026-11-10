import { failure } from "../result.ts";
import type { RunnerLifecycle } from "./runner-types.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import { now } from "../time.ts";
import { releasedArrival } from "./runner-coordinator-handoffs.ts";
import type { Handoff, RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";

/** A released Handoff to a Wait becomes a pending arrival; while its source is held it stays a
 * Handoff, so counting starts only at release. */
export function prepareWaitHandoff(store: RunStore, t3: T3Adapter, run: RunRow, handoff: Handoff) {
  return Effect.gen(function* () {
    const current = yield* releasedArrival(store, t3, run, handoff);
    if (current) yield* store.handoffToWaitArrival(current, handoff);
  });
}

/** Forwards every pending arrival of the Run whose deadline has passed, once each and without a T3
 * call; an arrival overdue after downtime is forwarded now, with its deadline unchanged. */
export function forwardDueWaits(store: RunStore, runId: string) {
  return Effect.gen(function* () {
    const time = yield* now;
    for (const wait of yield* store.pendingWaits(runId)) {
      if (wait.deadline_at > time) return;
      yield* store.forwardWaitArrival(wait.id, "elapsed");
    }
  });
}

/** Manual forwarding shares the timer's durable claim; delivery retains its own authorization. */
export function openRunnerWaits(
  store: RunStore,
  lifecycle: RunnerLifecycle,
  disableTimer: (id: string) => Effect.Effect<void>,
) {
  const continueWaitArrival = (id: string) =>
    Effect.gen(function* () {
      if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
      if (typeof id !== "string" || !id.trim() || id.length > 256)
        return failure("validation", "Choose a valid Wait arrival id.");
      const result = yield* store.forwardWaitArrival(id, "early");
      if (result.outcome === "already-forwarded")
        return failure("conflict", "This Wait arrival was already forwarded.");
      if (result.outcome !== "forwarded" || !result.runId)
        return failure("conflict", "This Wait arrival cannot be forwarded.");
      yield* disableTimer(id);
      const detail = yield* lifecycle.getRun(result.runId);
      yield* lifecycle.fork(lifecycle.drive(result.runId, "dispatch"));
      return detail;
    }).pipe(Effect.uninterruptible);
  return { continueWaitArrival };
}

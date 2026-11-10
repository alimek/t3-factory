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

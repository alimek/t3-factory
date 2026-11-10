import { releaseResult } from "./result-release.ts";
import type { T3Adapter } from "../adapters/t3.ts";
import * as Effect from "effect/Effect";
import type { Handoff, RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";
import { launchStrategy } from "./run-workspace.ts";

/** Independent arrivals reserve a new activation only after the target conversation settles. */
export function prepareCoordinatorHandoff(
  store: RunStore,
  t3: T3Adapter,
  run: RunRow,
  handoff: Handoff,
) {
  return Effect.gen(function* () {
    const current = yield* store.readRun(run.id);
    if (!current || !current.gate_open || !handoff.source_block_id) return undefined;
    // Keep held arrivals as handoffs, not phantom delegating activations. Reservation
    // independently repeats this gate before any external effect.
    if (!(yield* sourceReleased(store, t3, current, handoff))) return undefined;
    const arrival = yield* store.arrivalAt(run.id, handoff.block_id);
    // An unresolved launch for the target holds its arrival.
    if (arrival.launchUnresolved) return undefined;
    // A worktree Run's later workers join its worktree, so they wait until it is bound.
    const strategy = launchStrategy(current.workspace, handoff.block_id);
    if (!strategy) return undefined;
    // A revisit waits until the target's previous activation has its current result released.
    const previous = arrival.previousVisit;
    if (
      previous &&
      !(previous.result_id && (yield* releaseResult(store, t3, current, previous.result_id)))
    )
      return undefined;
    return yield* store.handoffToActivation(current, handoff, previous, strategy);
  });
}

/** Human answers are durable authority; Agent reports still require their result's release. */
function sourceReleased(store: RunStore, t3: T3Adapter, current: RunRow, handoff: Handoff) {
  return handoff.report_id
    ? releaseResult(store, t3, current, handoff.report_id)
    : Effect.succeed(handoff.state === "released");
}

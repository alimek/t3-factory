import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import { releaseResult } from "./result-release.ts";
import { releasedArrival } from "./runner-coordinator-handoffs.ts";
import type { Handoff, RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";

/**
 * A released Handoff to a Continuation: the first one sends the prompt (answered as the delivery),
 * one arriving while the prompt is pending waits, and later ones pass through unchanged.
 */
export function prepareContinuationHandoff(
  store: RunStore,
  t3: T3Adapter,
  run: RunRow,
  handoff: Handoff,
) {
  return Effect.gen(function* () {
    const current = yield* releasedArrival(store, t3, run, handoff);
    if (!current) return undefined;
    const prompt = yield* store.continuationPrompt(run.id, handoff.block_id);
    if (!prompt) return yield* store.sendContinuationPrompt(current, handoff);
    if (prompt.state === "forwarded") yield* store.passThroughArrival(current, handoff);
    else if (prompt.state === "sent") yield* store.queueContinuationArrival(current, handoff);
    return undefined;
  });
}

/** Releases each Continuation result whose worker thread is finished, so its response is
 * forwarded even when no Handoff asks for the release. */
export function releaseContinuationResults(store: RunStore, t3: T3Adapter, run: RunRow) {
  return Effect.gen(function* () {
    for (const reportId of yield* store.heldContinuationResults(run.id)) {
      const current = yield* store.readRun(run.id);
      if (!current?.gate_open) return;
      yield* releaseResult(store, t3, current, reportId);
    }
  });
}

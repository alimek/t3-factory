import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import { failure } from "../result.ts";
import type { RunStore, WaitForwarding } from "./run-store/run-store.ts";
import type { RunnerLifecycle } from "./runner-types.ts";

/** Why Continue now changed nothing. A user forwarding is never refused for its deadline. */
const refusals: Record<Exclude<WaitForwarding, "forwarded" | "not-due">, Result<never>> = {
  "not-found": failure("not_found", "This Wait arrival does not exist."),
  "already-forwarded": failure("conflict", "This Wait arrival was already forwarded."),
  cancelled: failure("conflict", "This Wait arrival was cancelled when its Run was archived."),
  closed: failure("conflict", "This Run is archived and forwards no Wait arrival."),
};

export function openRunnerWaits(
  store: RunStore,
  lifecycle: RunnerLifecycle,
  cancelTimer: (arrivalId: string) => Effect.Effect<void>,
) {
  const { isClosed, drive, fork, getRun } = lifecycle;

  /** Continue now: forwards arrival `id` through the same guarded transition as its timer,
   * disables the timer and dispatches the new Handoffs. */
  function continueWaitArrival(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (isClosed()) return failure("conflict", "Factory is shutting down.");
      if (!id.trim() || id.length > 200) return failure("validation", "Choose a Wait arrival.");
      const runId = yield* store.waitArrivalRunId(id);
      if (!runId) return refusals["not-found"];
      const outcome = yield* store.forwardWaitArrival(runId, id, "user");
      if (outcome !== "forwarded")
        return outcome === "not-due" ? refusals.closed : refusals[outcome];
      yield* cancelTimer(id);
      const detail = yield* getRun(runId);
      yield* fork(drive(runId, "dispatch"));
      return detail;
    });
  }

  return { continueWaitArrival };
}

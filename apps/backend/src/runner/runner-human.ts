import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import { failure } from "../result.ts";
import type { RunStore } from "./run-store/run-store.ts";
import type { RunnerLifecycle } from "./runner-types.ts";
export function openRunnerHuman(store: RunStore, lifecycle: RunnerLifecycle) {
  const { isClosed, drive, getRun } = lifecycle;
  function answerHumanOccurrence(
    id: string,
    input: unknown,
  ): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (isClosed()) return failure("conflict", "Factory is shutting down.");
      if (!input || typeof input !== "object" || Array.isArray(input))
        return failure("validation", "Send an answer object.");
      const { exitId, message } = input as {
        exitId?: unknown;
        message?: unknown;
      };
      if (
        (exitId !== undefined && typeof exitId !== "string") ||
        (message !== undefined && (typeof message !== "string" || message.length > 100000))
      )
        return failure("validation", "Choose an exit and use text up to 100,000 characters.");
      const answered = yield* store.answerHumanOccurrence(id, { exitId, message });
      if (!answered.ok) return answered;
      const detail = yield* getRun(answered.value.runId);
      if (!isClosed()) yield* lifecycle.fork(drive(answered.value.runId, "dispatch"));
      return detail;
    });
  }
  return { answerHumanOccurrence };
}

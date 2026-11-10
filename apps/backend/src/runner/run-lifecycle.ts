import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import { failure } from "../result.ts";
import type { RunnerLifecycle } from "./runner-types.ts";

/**
 * A user's lifecycle change is decided and recorded by a Run store transition; its T3 effects
 * follow in the background, so the request never waits for T3. `transition` answers whether the
 * Run changed.
 */
export function changeLifecycle(
  lifecycle: RunnerLifecycle,
  id: string,
  transition: Effect.Effect<Result<boolean>, unknown>,
  inT3: Effect.Effect<void, unknown>,
): Effect.Effect<Result<RunDetail>, unknown> {
  return Effect.gen(function* () {
    if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
    const changed = yield* transition;
    if (!changed.ok) return changed;
    if (changed.value) yield* lifecycle.fork(inT3);
    return yield* lifecycle.getRun(id);
  });
}

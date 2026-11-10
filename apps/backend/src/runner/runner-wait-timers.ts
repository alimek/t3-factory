import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { ScheduledWait } from "./run-store/run-store.ts";

/**
 * One wake-up per pending Wait arrival on the Runner's clock. The deadline is durable in the Run
 * store; a wake-up only asks the Runner to drive the Run, whose dispatch pass forwards every due
 * arrival through the store's guarded transition. A lost or extra wake-up therefore changes
 * nothing: restart schedules the pending arrivals again and the reconcile sweep catches overdue
 * ones.
 */
export function makeWaitTimers(
  scope: Scope.Scope,
  wake: (runId: string) => Effect.Effect<void, unknown>,
) {
  const timers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  let closed = false;

  /** Wakes the arrival's Run at its deadline, at once when it already passed; an arrival already
   * scheduled keeps its wake-up. */
  const schedule = (wait: ScheduledWait) =>
    Effect.gen(function* () {
      if (closed || timers.has(wait.id)) return;
      const delay = Math.max(0, Date.parse(wait.deadlineAt) - (yield* Clock.currentTimeMillis));
      const fiber = yield* Effect.forkIn(
        Effect.sleep(delay).pipe(
          Effect.andThen(Effect.sync(() => timers.delete(wait.id))),
          Effect.andThen(wake(wait.runId)),
        ),
        scope,
      );
      timers.set(wait.id, fiber);
    });

  /** Stops every pending wake-up; the deadlines stay in the Run store for the next owner. */
  const close = () =>
    Effect.gen(function* () {
      closed = true;
      yield* Fiber.interruptAll(timers.values());
      timers.clear();
    });

  return { schedule, close };
}

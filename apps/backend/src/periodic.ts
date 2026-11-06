import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Runs `pass` every `intervalMs` in the current scope; a failed pass waits for the next tick.
 * The returned effect stops the worker and then runs `drain`, so shutdown can wait for an
 * in-flight serialized mutation before releasing the resources it uses.
 */
export const periodicWorker = Effect.fn("periodicWorker")(function* (
  intervalMs: number,
  pass: Effect.Effect<unknown, unknown>,
  drain: Effect.Effect<void>,
) {
  const worker = yield* Effect.forever(
    Effect.sleep(intervalMs).pipe(
      Effect.andThen(pass),
      Effect.catch(() => Effect.void),
    ),
  ).pipe(Effect.forkScoped);
  return Fiber.interrupt(worker).pipe(Effect.andThen(drain));
});

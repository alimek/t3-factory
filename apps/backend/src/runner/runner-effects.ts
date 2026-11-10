import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/** Remote/protocol failures become uncertainty; cancellation never fabricates evidence. */
export const recoverOperation = <A, E, R, B, E2, R2>(
  operation: Effect.Effect<A, E, R>,
  recover: (error: unknown) => Effect.Effect<B, E2, R2>,
): Effect.Effect<A | B, E | E2, R | R2> =>
  operation.pipe(
    Effect.catchCause((cause): Effect.Effect<B, E | E2, R2> =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : recover(Cause.squash(cause)),
    ),
  );

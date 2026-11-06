import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** Persist observation time from the current runtime's clock. */
export const now = Clock.currentTimeMillis.pipe(
  Effect.map((milliseconds) => new Date(milliseconds).toISOString()),
);

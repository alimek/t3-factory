import type * as Effect from "effect/Effect";

/** Backend service operations; Promise translation belongs only at external entry points. */
export type EffectOperations<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => Effect.Effect<A, unknown>
    : T[K];
};

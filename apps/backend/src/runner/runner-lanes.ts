import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Queued work owns a lane until every earlier operation has left it. */
export function makeRunLanes() {
  const lanes = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const serial = <A, E>(id: string, action: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      let lane = lanes.get(id);
      if (!lane) {
        lane = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lanes.set(id, lane);
      }
      const held = lane;
      held.users++;
      return held.semaphore.withPermit(Effect.suspend(action)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            held.users--;
            if (held.users === 0) lanes.delete(id);
          }),
        ),
      );
    });
  return {
    serial,
    /** Waits for the queued work of `ids`, or of every lane when omitted. */
    drain: (ids?: readonly string[]) =>
      Effect.suspend(() =>
        Effect.all(
          (ids ? ids.flatMap((id) => lanes.get(id) ?? []) : [...lanes.values()]).map((lane) =>
            lane.semaphore.withPermit(Effect.void),
          ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
  };
}

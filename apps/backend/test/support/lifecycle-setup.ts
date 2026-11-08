import type { ControlledT3 } from "./controlled-t3.ts";

export function restoreLaunches(
  t3: ControlledT3,
  entries: Iterable<[string, Parameters<ControlledT3["launches"]["set"]>[1]]>,
) {
  for (const [key, value] of entries) t3.launches.set(key, value);
}

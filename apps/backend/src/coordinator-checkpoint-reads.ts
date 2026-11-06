import type { T3Adapter } from "./adapters/t3.ts";

/** Replay only the independently read frontier, never fetch newer data inside SQL.
 * Recorded execution IDs are coverage requirements, not part of the read identity:
 * readCoordination checks every newly retained obligation against the replay. */
export function checkpointReads(t3: T3Adapter) {
  const reads = new Map<string, unknown>();
  let replay = false;
  const adapter = new Proxy(t3, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        const key = JSON.stringify([
          property,
          property === "readExecution" ? args.slice(0, 2) : args,
        ]);
        if (replay) {
          if (!reads.has(key)) throw Error("Checkpoint frontier changed.");
          return structuredClone(reads.get(key));
        }
        const result: unknown = await Reflect.apply(method, target, args);
        reads.set(key, structuredClone(result));
        return result;
      };
    },
  });
  return {
    adapter,
    freeze: () => {
      replay = true;
    },
  };
}

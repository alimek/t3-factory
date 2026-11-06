import * as Effect from "effect/Effect";
import type { RemoteWorkObservation } from "./adapters/remote-work.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";

/** Positive input is retained independently of a stale lifecycle decision. */
export function remoteInputRetention(
  database: RunnerDatabase,
  run: RunRow,
  blockId?: string,
  onChange?: () => void,
) {
  return async (observation: RemoteWorkObservation) => {
    const count = observation.pendingRequestCount;
    if (!observation.available || count === null || !Number.isSafeInteger(count) || count <= 0)
      return;
    const changed = await Effect.runPromise(
      database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return false;
          const retained =
            yield* sql`UPDATE coordinator_remote_work SET pending_request_count=${count}
            WHERE resolved=0 AND environment_id=${observation.environmentId} AND thread_id=${observation.threadId}
            AND COALESCE(pending_request_count,0)<${count}
            AND activation_id IN (SELECT id FROM run_activations WHERE run_id=${run.id} AND (${blockId ?? null} IS NULL OR block_id=${blockId ?? null}))
            RETURNING id`;
          if (retained.length)
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          return retained.length > 0;
        }),
      ),
    );
    if (changed) onChange?.();
  };
}

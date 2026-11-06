import { observationLedger } from "./observation-ledger.ts";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
export interface PeerObligation {
  threadId: string;
  kind: "member" | "queued" | "execution" | "native" | "nested";
  reference: string;
}
/** Monotone safety records. Never execution membership or report authority. */
export function peerLedger(
  database: RunnerDatabase,
  run: RunRow,
  environmentId: string,
  rootThreadId: string,
) {
  const ledger = {
    read: () =>
      Effect.runPromise(
        database.transaction(
          (sql) =>
            sql<PeerObligation>`SELECT thread_id AS threadId,kind,reference FROM coordinator_peer_obligations WHERE run_id=${run.id} AND environment_id=${environmentId} AND root_thread_id=${rootThreadId}`,
        ),
      ),
    retain: (rows: readonly PeerObligation[]) =>
      Effect.runPromise(
        database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, run)))
              throw Error("Peer Stop context changed");
            for (const row of rows) {
              const inserted =
                yield* sql`INSERT INTO coordinator_peer_obligations(run_id,environment_id,root_thread_id,thread_id,kind,reference) VALUES(${run.id},${environmentId},${rootThreadId},${row.threadId},${row.kind},${row.reference}) ON CONFLICT DO NOTHING RETURNING reference`;
              if (inserted.length)
                yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
            }
          }),
        ),
      ),
  };
  return run.closed_at ? observationLedger(ledger.read) : ledger;
}

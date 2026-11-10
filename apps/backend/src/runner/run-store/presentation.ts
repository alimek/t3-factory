import type { Result, RunPresentation } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./database.ts";
import { withLifecycle } from "./lifecycle.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "../../result.ts";

/** Settling and archiving clear Snooze and Woke. */
export function clearSnooze(sql: SqlClient.SqlClient, runId: string) {
  return sql`UPDATE run_presentation SET snoozed=0,woke=0 WHERE run_id=${runId}`;
}

/** Snooze, Restore and marking Woke seen share the Run's mutation lane but never advance its
 * generation. Guards: the Run exists; Snooze and Restore also need it neither Settled nor Archived. */
export function openRunPresentation(database: RunnerDatabase) {
  function update(
    id: string,
    action: "snooze" | "restore" | "seen",
  ): Effect.Effect<Result<RunPresentation>, unknown> {
    return withLifecycle<RunPresentation>(database, id, (sql, run) =>
      Effect.gen(function* () {
        if ((run.archived_at || run.settled_at) && action !== "seen")
          return failure("conflict", "Only Active Runs can be snoozed or restored.");
        yield* sql`INSERT INTO run_presentation(run_id) VALUES(${id}) ON CONFLICT DO NOTHING`;
        if (action === "snooze") {
          yield* sql`DELETE FROM run_snooze_attention WHERE run_id=${id}`;
          yield* sql`INSERT INTO run_snooze_attention(run_id,attention_id)
            SELECT run_id,id FROM run_attention WHERE run_id=${id} AND settled_at IS NULL`;
          yield* sql`UPDATE run_presentation SET snoozed=1,woke=0 WHERE run_id=${id}`;
        } else if (action === "restore") {
          yield* clearSnooze(sql, id);
        } else {
          yield* sql`UPDATE run_presentation SET woke=0 WHERE run_id=${id}`;
        }
        const [state] = yield* sql<{
          snoozed: number;
          woke: number;
        }>`SELECT snoozed,woke FROM run_presentation WHERE run_id=${id}`;
        return { ok: true as const, value: { snoozed: !!state!.snoozed, woke: !!state!.woke } };
      }),
    );
  }
  return {
    snoozeRun: (id: string) => update(id, "snooze"),
    restoreRun: (id: string) => update(id, "restore"),
    markRunWokeSeen: (id: string) => update(id, "seen"),
  };
}

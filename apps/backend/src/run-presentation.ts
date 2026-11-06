import type { Result, RunPresentation } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import { failure } from "./result.ts";
/** Presentation shares the Runner mutation lane but never changes its execution generation. */
export function openRunPresentation(database: RunnerDatabase) {
  function update(
    id: string,
    action: "snooze" | "restore" | "seen",
  ): Effect.Effect<Result<RunPresentation>, unknown> {
    return database.mutate(id, (sql) =>
      Effect.gen(function* () {
        const [run] = yield* sql<{
          closed_at: string | null;
        }>`SELECT closed_at FROM runs WHERE id=${id}`;
        if (!run) return failure("not_found", "This Run does not exist.");
        if (run.closed_at && action !== "seen")
          return failure("conflict", "Closed Runs remain in Settled.");
        yield* sql`INSERT INTO run_presentation(run_id) VALUES(${id}) ON CONFLICT DO NOTHING`;
        if (action === "snooze") {
          yield* sql`DELETE FROM run_snooze_attention WHERE run_id=${id}`;
          yield* sql`INSERT INTO run_snooze_attention(run_id,attention_id)
            SELECT run_id,id FROM run_attention WHERE run_id=${id} AND settled_at IS NULL`;
          yield* sql`UPDATE run_presentation SET snoozed=1,woke=0 WHERE run_id=${id}`;
        } else if (action === "restore") {
          yield* sql`UPDATE run_presentation SET snoozed=0,woke=0 WHERE run_id=${id}`;
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

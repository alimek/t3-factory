import type { Result } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "../../result.ts";
import type { RunnerDatabase } from "./runner-database.ts";

type Lifecycle = { readonly archived_at: string | null; readonly settled_at: string | null };

/** Whether a Run is Settled or Archived, read inside its mutation lane. */
function readLifecycle(sql: SqlClient.SqlClient, id: string) {
  return Effect.map(
    sql<Lifecycle>`SELECT archived_at,settled_at FROM runs WHERE id=${id}`,
    ([run]) =>
      run ? { ok: true as const, value: run } : failure("not_found", "This Run does not exist."),
  );
}

/** A user's lifecycle transition, decided in the Run's mutation lane from its current lifecycle. */
export function withLifecycle<A>(
  database: RunnerDatabase,
  id: string,
  change: (
    sql: SqlClient.SqlClient,
    run: Lifecycle,
  ) => Effect.Effect<Result<A>, unknown, SqlClient.SqlClient>,
): Effect.Effect<Result<A>, unknown> {
  return database.mutate(id, (sql) =>
    Effect.gen(function* () {
      const run = yield* readLifecycle(sql, id);
      return run.ok ? yield* change(sql, run.value) : run;
    }),
  );
}

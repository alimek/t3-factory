import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle } from "./runner-types.ts";

type Lifecycle = { readonly archived_at: string | null; readonly settled_at: string | null };

/** Whether a Run is Settled or Archived, read inside its mutation lane. */
export function readLifecycle(sql: SqlClient.SqlClient, id: string) {
  return Effect.map(
    sql<Lifecycle>`SELECT archived_at,settled_at FROM runs WHERE id=${id}`,
    ([run]) =>
      run ? { ok: true as const, value: run } : failure("not_found", "This Run does not exist."),
  );
}

/**
 * A user's lifecycle change is decided and recorded in the Run's lane; its T3 effects follow in
 * the background, so the request never waits for T3. `change` answers whether the Run changed.
 */
export function changeLifecycle(
  database: RunnerDatabase,
  lifecycle: RunnerLifecycle,
  id: string,
  change: (
    sql: SqlClient.SqlClient,
    run: Lifecycle,
  ) => Effect.Effect<Result<boolean>, unknown, SqlClient.SqlClient>,
  inT3: Effect.Effect<void, unknown>,
): Effect.Effect<Result<RunDetail>, unknown> {
  return Effect.gen(function* () {
    if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
    const changed = yield* database.mutate(id, (sql) =>
      Effect.gen(function* () {
        const run = yield* readLifecycle(sql, id);
        return run.ok ? yield* change(sql, run.value) : run;
      }),
    );
    if (!changed.ok) return changed;
    if (changed.value) yield* lifecycle.fork(inT3);
    return yield* lifecycle.getRun(id);
  });
}

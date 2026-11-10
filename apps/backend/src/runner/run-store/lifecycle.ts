import type { Result, RunLifecycle } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "../../result.ts";
import type { RunnerDatabase } from "./database.ts";

type Lifecycle = { readonly archived_at: string | null; readonly settled_at: string | null };

/** The Run lifecycle its timestamps record: Archived over Settled over Active. */
export function runLifecycle(
  run: Lifecycle & { readonly archived_at: null },
): Exclude<RunLifecycle, "archived">;
export function runLifecycle(run: Lifecycle): RunLifecycle;
export function runLifecycle(run: Lifecycle): RunLifecycle {
  if (run.archived_at) return "archived";
  return run.settled_at ? "settled" : "active";
}

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

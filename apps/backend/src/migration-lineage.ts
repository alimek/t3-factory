import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { MigrationError } from "@effect/sql-sqlite-node/SqliteMigrator";

// The unpublished coordinator branch occupied main's client-access version 026.
// Match the entire known suffix before touching its ledger; never infer from MAX(id).
const historical = new Map([
  [26, "agent_coordinator"],
  [27, "coordinator_start"],
  [28, "coordinator_lifecycle"],
  [29, "coordinator_conversation"],
  [30, "coordinator_revisits"],
  [31, "coordinator_recovery"],
  [32, "coordinator_stop"],
  [33, "coordinator_release"],
  [34, "native_obligations"],
  [35, "remote_obligations"],
  [37, "peer_stop"],
  [38, "activation_context"],
  [39, "local_execution_evidence"],
]);

/** Runs under the Factory ownership lock, before Effect's highest-version migrator. */
export function reconcileMigrationLineage(clientAccess: Effect.Effect<void, unknown>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists =
      yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='effect_sql_migrations'`;
    if (!exists.length) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id>=26 ORDER BY migration_id DESC`;
        if (!rows.some((row) => row.migration_id === 26 && row.name === "agent_coordinator"))
          return;
        if (rows.some((row) => historical.get(row.migration_id) !== row.name))
          return yield* Effect.fail(
            new MigrationError({
              kind: "BadState",
              message: "Unrecognized coordinator migration lineage.",
            }),
          );
        // Apply the real missing migration, then relabel already-applied coordinator
        // migrations in descending order to avoid primary-key collisions. Keep timestamps.
        yield* clientAccess;
        for (const row of rows)
          yield* sql`UPDATE effect_sql_migrations SET migration_id=${row.migration_id + 1} WHERE migration_id=${row.migration_id}`;
        yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(26,'client_access')`;
      }),
    );
  });
}

import { readFileSync, readdirSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "@effect/sql-sqlite-node/SqliteMigrator";

import { reconcileMigrationLineage } from "./migration-lineage.ts";

const directory = new URL("./migrations/", import.meta.url);
const files = readdirSync(directory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
if (
  files.some((file) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) ||
  new Set(files.map((file) => file.slice(0, 3))).size !== files.length
) {
  throw new Error("SQL migrations need unique NNN_name.sql versions.");
}

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA synchronous = FULL`;
  const execute = (file: string) =>
    Effect.forEach(
      readFileSync(new URL(file, directory), "utf8")
        .split(/^-- statement-breakpoint\s*$/m)
        .filter((part) => part.trim()),
      (statement) => Effect.asVoid(sql.unsafe(statement)),
    ).pipe(Effect.asVoid);
  yield* reconcileMigrationLineage(execute("026_client_access.sql"));
  yield* Migrator.run({
    loader: Migrator.fromRecord(
      Object.fromEntries(files.map((file) => [file.slice(0, -4), execute(file)])),
    ),
  });
});

import { DatabaseSync } from "node:sqlite";

/** Read SQLite's declarations after the public Factory lifetime has ended. */
export function schemaSnapshot(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const newest = db
      .prepare("SELECT name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1")
      .get() as { name: string };
    const declarations = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger')
           AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL
         ORDER BY tbl_name, CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
      )
      .all() as { sql: string }[];
    return [
      "-- Generated current-schema snapshot. Do not edit by hand.",
      "-- Regenerate: pnpm --filter @t3-factory/backend schema:update",
      `-- Newest applied migration: ${newest.name}`,
      "",
      declarations.map(({ sql }) => `${sql};`).join("\n\n"),
      "",
    ].join("\n");
  } finally {
    db.close();
  }
}

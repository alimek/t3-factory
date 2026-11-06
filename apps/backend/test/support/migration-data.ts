import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

interface MigrationData<Expected> {
  format: number;
  /** Captured sqlite_schema table declarations. */
  schema: string[];
  /** Captured indexes/triggers restored after loading rows, preserving final constraints. */
  postDataSchema?: string[];
  tables: { table: string; rows: Record<string, SQLInputValue>[] }[];
  expected: Expected;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/** Restore captured data before opening Factory. Never creates historical data via current APIs. */
export async function loadMigrationData<Expected>(databasePath: string, fixtureName: string) {
  const fixture: MigrationData<Expected> = JSON.parse(
    await readFile(new URL(`../fixtures/${fixtureName}`, import.meta.url), "utf8"),
  );
  assert.equal(fixture.format, 1);
  assert(Array.isArray(fixture.schema));
  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()!.n, 0);
    db.exec("BEGIN");
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const statement of fixture.schema) db.exec(statement);
    for (const { table, rows } of fixture.tables) {
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(
          `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(row));
      }
    }
    for (const statement of fixture.postDataSchema ?? []) db.exec(statement);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return fixture.expected;
}

import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ControlledT3 } from "./controlled-t3.ts";
import { writeReportingState } from "./reporting-home.ts";

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

/**
 * The controlled adapter state a capture recorded, with its Maps and Sets restored, and a
 * disposable reporting home for it. `retired` names captured fields current code no longer has.
 */
export async function restoreCapturedAdapter(
  observations: Record<string, unknown>,
  processHome: string,
  retired: ReadonlySet<string> = new Set(),
) {
  const t3 = new ControlledT3();
  for (const [key, value] of Object.entries(observations)) {
    if (retired.has(key)) continue;
    assert(Object.hasOwn(t3, key), `Unknown captured adapter field: ${key}`);
    const restored =
      value && typeof value === "object" && "map" in value && Array.isArray(value.map)
        ? new Map(value.map as [string, unknown][])
        : value && typeof value === "object" && "set" in value
          ? new Set(value.set as unknown[])
          : value;
    Object.assign(t3, { [key]: restored });
  }
  const state = join(processHome, "reporting-state");
  const home = join(processHome, "codex-home");
  await mkdir(state);
  await mkdir(home);
  await writeReportingState(state, t3.environmentId, home);
  return t3;
}

import { assert, type TestContext } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { prepared } from "./prepared-runner.ts";

/** Stored history may omit the Run number; reads must preserve that absence. */
export async function unnumberedRun(c: TestContext) {
  const fixture = await prepared(c);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.settleRun(started.value.id, {})).ok);
  await fixture.f.close();
  const database = new DatabaseSync(fixture.h.databasePath);
  try {
    database.prepare("UPDATE runs SET number=NULL WHERE id=?").run(started.value.id);
  } finally {
    database.close();
  }
  const f = await fixture.h.open({ t3: fixture.t3, connectionRetryMs: 60_000 });
  return { f, runId: started.value.id };
}

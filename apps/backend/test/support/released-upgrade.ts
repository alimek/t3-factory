import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assert, type TestContext } from "@effect/vitest";
import type { Factory } from "@t3-factory/backend";
import { writeReportingState } from "./reporting-home.ts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { loadMigrationData } from "./migration-data.ts";

type Success<T> = T extends { ok: true; value: infer V } ? V : never;
type Value<K extends keyof Factory> = Factory[K] extends (...args: never[]) => infer R
  ? Success<Awaited<R>>
  : never;
interface ReleasedCapture {
  t3: Record<string, unknown>;
  project: Value<"addRepository">;
  clients: Value<"listClients">;
  approvedCredential: string;
  revokedCredential: string;
  flow: Value<"getFlow">;
  agent: Value<"getAgent">;
  /** Edited after the closed Run started, then removed from the catalog. */
  retired: { flow: Value<"getFlow">; agent: Value<"getAgent"> };
  closed: Value<"getRun">;
  active: Value<"getRun">;
  tasks: Value<"listTasks">;
}

/** The one released-version capture, restored without rewriting its durable state. */
export async function releasedUpgradeData(c: TestContext) {
  const h = await factoryHarness(c);
  const { t3: observations, ...expected } = await loadMigrationData<ReleasedCapture>(
    h.databasePath,
    "v0.2.0-upgrade-data.json",
  );
  const t3 = new ControlledT3();
  for (const [key, value] of Object.entries(observations)) {
    assert(Object.hasOwn(t3, key), `Unknown captured adapter field: ${key}`);
    const restored =
      value && typeof value === "object" && "map" in value && Array.isArray(value.map)
        ? new Map(value.map as [string, unknown][])
        : value && typeof value === "object" && "set" in value
          ? new Set(value.set as unknown[])
          : value;
    Object.assign(t3, { [key]: restored });
  }
  const state = join(h.processHome, "reporting-state");
  const home = join(h.processHome, "codex-home");
  await mkdir(state);
  await mkdir(home);
  await writeReportingState(state, t3.environmentId, home);
  return { h, t3, ...expected };
}

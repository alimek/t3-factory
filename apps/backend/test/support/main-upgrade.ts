import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeReportingState } from "./reporting-home.ts";
import { assert, type TestContext } from "@effect/vitest";
import type { Factory } from "@t3-factory/backend";
import type { prepared } from "./prepared-runner.ts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { loadMigrationData } from "./migration-data.ts";

type Success<T> = T extends { ok: true; value: infer V } ? V : never;
type Run = Success<Awaited<ReturnType<Factory["getRun"]>>>;
type Setup = Pick<Awaited<ReturnType<typeof prepared>>, "agent" | "flow" | "input" | "project">;
type CapturedAgent = Run["snapshot"]["agents"][number] & {
  coordinator?: unknown;
  coordinatorStatus?: unknown;
};
type MainCapture = Setup & {
  before: Run;
  current: Omit<Run, "snapshot"> & {
    snapshot: Omit<Run["snapshot"], "agents"> & { agents: CapturedAgent[] };
  };
  approvedCredential: string;
  revokedCredential: string;
  clients: Success<Awaited<ReturnType<Factory["listClients"]>>>;
  t3: Record<string, unknown>;
};

/** Captured controlled-adapter fields whose removed-contract behavior no longer exists. */
const retiredAdapterFields = new Set(["runtimeValidated", "interrupts", "interruptRetryScope"]);

/** The one released-main capture, restored without rewriting its durable state. */
export async function mainUpgradeData(c: TestContext) {
  const h = await factoryHarness(c);
  const { t3: observations, ...expected } = await loadMigrationData<MainCapture>(
    h.databasePath,
    "main-client-access-data.json",
  );
  const t3 = new ControlledT3();
  for (const [key, value] of Object.entries(observations).filter(
    ([key]) => !retiredAdapterFields.has(key),
  )) {
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
  const currentSnapshot = {
    ...expected.current.snapshot,
    agents: expected.current.snapshot.agents.map(
      ({ coordinator: _coordinator, coordinatorStatus: _status, ...agent }) => agent,
    ),
  };
  return { h, t3, ...expected, currentSnapshot };
}

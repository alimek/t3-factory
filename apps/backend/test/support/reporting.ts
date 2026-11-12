import { assert, type TestContext } from "@effect/vitest";
import { isolatedUserHome, writeReportingState } from "./reporting-home.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryOperations } from "@t3-factory/contracts";
import { loadConfiguration } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";

/** An approved controlled T3 whose state lists one provider with a disposable harness home. */
async function reportingHomes(context: TestContext, driver: string) {
  const harness = await factoryHarness(context);
  const state = join(harness.processHome, "t3");
  const home = join(harness.processHome, "harness");
  await mkdir(state);
  await mkdir(home);
  const t3 = new ControlledT3();
  t3.approve();
  await writeReportingState(state, t3.environmentId, home, "test-provider", driver);
  return { harness, state, home, t3 };
}

/** Installs Factory MCP into the first discovered reporting target. */
export async function installFirstReportingTarget(
  factory: Pick<FactoryOperations, "getReportingInstallations" | "installReporting">,
) {
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);
  const targetId = targets.value[0]!.id;
  assert((await factory.installReporting({ targetId })).ok);
  return targetId;
}

export async function reportingFixture(context: TestContext, driver = "claudeAgent") {
  const { harness, state, home, t3 } = await reportingHomes(context, driver);
  const options = { t3, reportingStateDirectory: state };
  const factory = await harness.open(options);
  assert((await factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" })).ok);
  const config = join(home, driver === "codex" ? "config.toml" : ".claude.json");
  return { harness, factory, options, home, state, config, t3 };
}

export async function driverHomes(
  context: TestContext,
  instances: Record<string, { driver: string; config: Record<string, unknown> }>,
) {
  const userHome = await isolatedUserHome(context);
  const fixture = await reportingFixture(context);
  await writeFile(
    join(fixture.state, "settings.json"),
    JSON.stringify({
      providerInstances: Object.fromEntries(
        Object.entries(instances).map(([id, instance]) => [id, { ...instance, enabled: true }]),
      ),
    }),
  );
  return { ...fixture, home: userHome };
}

export async function installedReportingFixture(context: TestContext) {
  const fixture = await reportingFixture(context);
  return { ...fixture, targetId: await installFirstReportingTarget(fixture.factory) };
}

/** A listening backend whose Claude reporting entry was installed through its own API. */
export async function installedReportingServer(context: TestContext) {
  const { harness, state, home, t3 } = await reportingHomes(context, "claudeAgent");
  const server = await startServer(
    await loadConfiguration({ FACTORY_HOME: harness.processHome, FACTORY_PORT: "0" }),
    { t3, reportingStateDirectory: state, uiDirectory: null },
  );
  context.onTestFinished(() => server.close());
  assert((await server.factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" })).ok);
  await installFirstReportingTarget(server.factory);
  return { server, config: join(home, ".claude.json") };
}

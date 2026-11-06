import { assert, type TestContext } from "@effect/vitest";
import { writeReportingState } from "./reporting-home.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryOptions } from "@t3-factory/backend";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { reportingClient } from "./reporting-client.ts";

export async function reportingFixture(
  context: TestContext,
  driver = "claudeAgent",
  bridgeRuntime?: FactoryOptions["bridgeRuntime"],
) {
  const harness = await factoryHarness(context);
  const state = join(harness.processHome, "t3");
  const home = join(harness.processHome, "harness");
  await mkdir(state);
  await mkdir(home);
  const t3 = new ControlledT3();
  t3.approve();
  await writeReportingState(state, t3.environmentId, home, "test-provider", driver);
  const options = {
    t3,
    reportingStateDirectory: state,
    ...(bridgeRuntime ? { bridgeRuntime } : {}),
  };
  const factory = await harness.open(options);
  assert((await factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" })).ok);
  const config = join(home, driver === "codex" ? "config.toml" : ".claude.json");
  return { harness, factory, options, home, state, config, t3 };
}

export async function installedReportingFixture(context: TestContext) {
  const fixture = await reportingFixture(context);
  const targets = await fixture.factory.getReportingInstallations();
  assert(targets.ok);
  const targetId = targets.value[0]!.id;
  assert((await fixture.factory.installReporting({ targetId })).ok);
  return {
    ...fixture,
    targetId,
    connectionFile: join(fixture.harness.processHome, "reporting", "connection.json"),
  };
}

export async function installedReportingClient(context: TestContext) {
  const fixture = await reportingFixture(context);
  const targets = await fixture.factory.getReportingInstallations();
  assert(targets.ok);
  assert((await fixture.factory.installReporting({ targetId: targets.value[0]!.id })).ok);
  return reportingClient(context, fixture.config, fixture.home);
}

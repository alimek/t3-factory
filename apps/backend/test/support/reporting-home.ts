import type { TestContext } from "@effect/vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Only caller-owned disposable directories are passed by test fixtures. */
export async function writeReportingState(
  state: string,
  environmentId: string,
  home: string,
  provider = "codex-main",
  driver = "codex",
  config: Record<string, unknown> = { homePath: home },
) {
  await writeFile(join(state, "environment-id"), environmentId);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({ providerInstances: { [provider]: { driver, enabled: true, config } } }),
  );
}

function overrideEnvironment(context: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  context.onTestFinished(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

export async function isolatedUserHome(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "t3-factory-user-home-"));
  context.onTestFinished(() => rm(home, { recursive: true, force: true }));
  overrideEnvironment(context, "HOME", home);
  return home;
}

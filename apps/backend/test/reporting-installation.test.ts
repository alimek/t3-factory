import { assert, expect, it } from "@effect/vitest";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reportingClient } from "./support/reporting-client.ts";
import {
  reportingFixture,
  installedReportingClient,
  installedReportingFixture,
} from "./support/reporting.ts";
import { isolatedUserHome } from "./support/reporting-home.ts";

it("installing Claude reporting preserves unrelated user settings", async (context) => {
  // Arrange
  const { factory, config } = await reportingFixture(context);
  await writeFile(
    config,
    JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }),
  );
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);

  // Act
  const result = await factory.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(result.ok);
  expect(result.value.status).toBe("installed");
  expect(result.value.runtimeEvidence).toBe("UNVERIFIED");
  const saved = JSON.parse(await readFile(config, "utf8"));
  expect(saved.theme).toBe("dark");
  expect(saved.mcpServers.other).toStrictEqual({ command: "other" });
});

it("Codex installation preserves existing settings and survives backend restart without duplicates", async (context) => {
  // Arrange
  const { factory, config, harness, options } = await reportingFixture(context, "codex");
  await writeFile(
    config,
    '# keep this comment\nmodel = "sample"\n[mcp_servers.other]\ncommand = "other"\n',
  );
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);
  assert((await factory.installReporting({ targetId: targets.value[0]!.id })).ok);
  const before = await readFile(config, "utf8");
  await factory.close();
  const reopened = await harness.open(options);

  // Act
  const result = await reopened.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(result.ok);
  expect(result.value.status).toBe("installed");
  expect(await readFile(config, "utf8")).toBe(before);
  expect(before).toMatch(/# keep this comment/);
  expect(before).toMatch(/command = "other"/);
});

it("a conflicting configuration target exposes no repair action", async (context) => {
  // Arrange
  const { factory, config } = await reportingFixture(context);
  await writeFile(config, '{"mcpServers":{"factory-runtime":{"command":"someone-else"}}}');

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]!.status).toBe("needs-attention");
  expect(result.value[0]!.actions).toStrictEqual({
    install: false,
    repair: false,
    reinstall: false,
  });
});

it("a missing owned connection file offers repair", async (context) => {
  // Arrange
  const { factory, connectionFile } = await installedReportingFixture(context);
  await rm(connectionFile);

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]!.status).toBe("needs-attention");
  expect(result.value[0]!.actions).toStrictEqual({
    install: false,
    repair: true,
    reinstall: false,
  });
});

it("a conflicting Factory namespace is never overwritten", async (context) => {
  // Arrange
  const { factory, config } = await reportingFixture(context);
  const before = '{"mcpServers":{"factory-runtime":{"command":"someone-else"}}}';
  await writeFile(config, before);
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);

  // Act
  const result = await factory.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(!result.ok);
  expect(result.error.message).toMatch(/Conflicting/);
  expect(await readFile(config, "utf8")).toBe(before);
  expect(targets.value[0]!.status).toBe("needs-attention");
});

it("default provider homes resolve from the user home without explicit homePath", async (context) => {
  // Arrange
  const home = await isolatedUserHome(context);
  const { factory, state } = await reportingFixture(context);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({
      providerInstances: {
        "codex-main": { driver: "codex", config: {} },
        claude: { driver: "claudeAgent", config: {} },
      },
    }),
  );
  await mkdir(join(home, ".codex"));

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value.length).toBe(2);
  expect(result.value[0]!.message).toContain("standard home for this OS user");
  expect(result.value.find((target) => target.provider === "codex")!.path).toBe(
    join(await realpath(join(home, ".codex")), "config.toml"),
  );
  expect(result.value.find((target) => target.provider === "claudeAgent")!.path).toBe(
    join(await realpath(home), ".claude.json"),
  );
});

it("a different execution host never receives a local installation target", async (context) => {
  // Arrange
  const { factory, state } = await reportingFixture(context);
  await writeFile(join(state, "environment-id"), "another-machine");

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]!.path).toBe(null);
  expect(result.value[0]!.message).toMatch(/identity does not match/);
});

it("symbolic link configuration is not overwritten", async (context) => {
  // Arrange
  const { factory, config, home } = await reportingFixture(context);
  const other = join(home, "other.json");
  await writeFile(other, "{}");
  await symlink(other, config);
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);

  // Act
  const result = await factory.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(!result.ok);
  expect(result.error.message).toMatch(/Symlink/);
  expect(await readFile(other, "utf8")).toBe("{}");
});

it("the installed portable bridge exposes report and scoped context over stdio", async (context) => {
  // Arrange
  const rpc = await installedReportingClient(context);

  // Act
  const response = await rpc("tools/list");

  // Assert
  expect(response.result.tools.map((tool: { name: string }) => tool.name)).toStrictEqual([
    "factory_report",
    "factory_context",
  ]);
  expect(response.result.tools[0].name).toBe("factory_report");
  expect(response.result.tools[0].inputSchema.required).toStrictEqual(["key", "status"]);
});

const bundled = (executable = process.execPath) => ({ kind: "bundled" as const, executable });

it("a desktop installation's reporting bridge runs without Node on the harness PATH", async (context) => {
  // Arrange
  const { factory, config, home } = await reportingFixture(context, "claudeAgent", bundled());
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);
  assert((await factory.installReporting({ targetId: targets.value[0]!.id })).ok);
  const call = await reportingClient(context, config, home, "/nonexistent");

  // Act
  const listed = await call("tools/list");

  // Assert
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toStrictEqual([
    "factory_report",
    "factory_context",
  ]);
});

it("repairing for the desktop runtime replaces only Factory's own Codex entry", async (context) => {
  // Arrange
  const { factory, harness, options, config } = await reportingFixture(context, "codex");
  await writeFile(config, '# keep this comment\nmodel = "sample"\n');
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);
  assert((await factory.installReporting({ targetId: targets.value[0]!.id })).ok);
  await factory.close();
  const desktop = await harness.open({ ...options, bridgeRuntime: bundled() });

  // Act
  const result = await desktop.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(result.ok);
  expect(result.value.status).toBe("installed");
  const saved = await readFile(config, "utf8");
  expect(saved).toMatch(/^# keep this comment\nmodel = "sample"\n/);
  expect(saved.match(/\[mcp_servers\.factory-runtime\]/g)).toHaveLength(1);
  expect(saved).toMatch(/command = ".*\/reporting\/factory-runtime-node"/);
});

import { assert, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  driverHomes,
  reportingFixture,
  installedReportingFixture,
  installedReportingServer,
} from "./support/reporting.ts";
import { prepared } from "./support/prepared-runner.ts";
import { FACTORY_START_RUN_SKILL } from "../src/factory-start-run-skill.ts";
import { SETUP_FACTORY_SKILL } from "../src/setup-factory-skill.ts";
import { isolatedUserHome } from "./support/reporting-home.ts";

it("installing Claude reporting preserves unrelated user settings", async (context) => {
  // Arrange
  const { factory, config, home, harness } = await reportingFixture(context);
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
  expect(result.value.launchSkill).toBe("current");
  expect(
    await readFile(join(home, ".claude", "skills", "factory-start-run", "SKILL.md"), "utf8"),
  ).toBe(FACTORY_START_RUN_SKILL);
  expect(
    await readFile(
      join(harness.processHome, "reporting", "skills", "factory-start-run", "SKILL.md"),
      "utf8",
    ),
  ).toBe(FACTORY_START_RUN_SKILL);
  expect(await readFile(join(home, ".claude", "skills", "setup-factory", "SKILL.md"), "utf8")).toBe(
    SETUP_FACTORY_SKILL,
  );
  expect(
    await readFile(
      join(harness.processHome, "reporting", "skills", "setup-factory", "SKILL.md"),
      "utf8",
    ),
  ).toBe(SETUP_FACTORY_SKILL);
  expect(saved.theme).toBe("dark");
  expect(saved.mcpServers.other).toStrictEqual({ command: "other" });
});

it("Codex installation preserves existing settings and survives backend restart without duplicates", async (context) => {
  // Arrange
  const { factory, config, home, harness, options } = await reportingFixture(context, "codex");
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
  expect(await readFile(join(home, "skills", "factory-start-run", "SKILL.md"), "utf8")).toBe(
    FACTORY_START_RUN_SKILL,
  );
  expect(before).toMatch(/# keep this comment/);
  expect(before).toMatch(/command = "other"/);
});

it("a provider without Factory reporting is listed as unsupported with nothing to install", async (context) => {
  // Arrange
  const { factory } = await reportingFixture(context, "pi");

  // Act
  const targets = await factory.getReportingInstallations();

  // Assert
  assert(targets.ok);
  expect(targets.value).toMatchObject([
    {
      provider: "pi",
      instances: ["test-provider"],
      status: "unsupported",
      path: null,
      launchSkill: null,
      actions: { install: false, repair: false, reinstall: false },
    },
  ]);
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

it("a Factory entry for another backend address offers repair", async (context) => {
  // Arrange
  const { factory, config } = await installedReportingFixture(context);
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: { "factory-runtime": { type: "http", url: "http://127.0.0.1:4999/mcp" } },
    }),
  );

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

it("installing Cursor reporting writes the user MCP file", async (context) => {
  // Arrange
  const { factory, home } = await driverHomes(context, {
    cursor: { driver: "cursor", config: {} },
  });
  await mkdir(join(home, ".cursor"));
  await writeFile(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({ theme: "dark", mcpServers: { other: { command: "keep" } } }),
  );
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);
  const cursor = targets.value.find((target) => target.provider === "cursor")!;

  // Act
  const installed = await factory.installReporting({ targetId: cursor.id });

  // Assert
  assert(installed.ok);
  expect(installed.value.status).toBe("installed");
  expect(
    await readFile(join(home, ".cursor", "skills", "factory-start-run", "SKILL.md"), "utf8"),
  ).toBe(FACTORY_START_RUN_SKILL);
  expect(JSON.parse(await readFile(cursor.path!, "utf8"))).toMatchObject({
    theme: "dark",
    mcpServers: { other: { command: "keep" } },
  });
  expect(cursor.path).toBe(join(await realpath(home), ".cursor", "mcp.json"));
  expect(
    JSON.parse(await readFile(cursor.path!, "utf8")).mcpServers["factory-runtime"],
  ).toStrictEqual({ url: "http://127.0.0.1:4310/mcp" });
});

it("Grok reporting uses the standard home and stays not installed until install", async (context) => {
  // Arrange
  const { factory, home } = await driverHomes(context, { grok: { driver: "grok", config: {} } });
  await mkdir(join(home, ".grok"));

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  const grok = result.value.find((target) => target.provider === "grok")!;
  expect(grok.path).toBe(join(await realpath(join(home, ".grok")), "config.toml"));
  expect(grok.status).toBe("not-installed");
});

it("a provider without reporting shows the MCP address and no install action", async (context) => {
  // Arrange
  const { factory } = await driverHomes(context, { pi: { driver: "pi", config: {} } });

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  const pi = result.value.find((target) => target.provider === "pi")!;
  expect(pi.path).toBe(null);
  expect(pi.message).toMatch(/factory-runtime/);
  expect(pi.message).toContain("http://127.0.0.1:4310/mcp");
  expect(pi.actions).toStrictEqual({ install: false, repair: false, reinstall: false });
});

it("an unresolvable Codex home keeps its discovery message", async (context) => {
  // Arrange
  const { factory, state } = await reportingFixture(context);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({
      providerInstances: { codex: { driver: "codex", config: { homePath: "relative/codex" } } },
    }),
  );

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]!.message).toMatch(/Relative provider homes/);
  expect(result.value[0]!.message).not.toMatch(/no installer/);
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

it("an installed Claude entry reaches the Factory tools on the listening backend", async (context) => {
  // Arrange
  const { config } = await installedReportingServer(context);
  const entry = JSON.parse(await readFile(config, "utf8")).mcpServers["factory-runtime"];
  const client = new Client({ name: "harness", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url)));
  context.onTestFinished(() => client.close());

  // Act
  const listed = await client.listTools();

  // Assert
  expect(entry.type).toBe("http");
  expect(listed.tools.map((tool) => tool.name)).toStrictEqual([
    "factory_update_block",
    "factory_get_block",
    "factory_get_run_image",
    "factory_get_run",
    "factory_get_agent_capabilities",
    "factory_list_agents",
    "factory_get_agent",
    "factory_create_agent",
    "factory_save_agent",
    "factory_list_flows",
    "factory_get_flow",
    "factory_create_flow",
    "factory_save_flow",
    "factory_check_flow",
    "factory_list_projects",
    "factory_start_run",
  ]);
  expect(listed.tools.map((tool) => tool.inputSchema.required)).toStrictEqual([
    ["blockId", "to"],
    ["blockId"],
    ["blockId", "imageId"],
    ["blockId"],
    undefined,
    undefined,
    ["agentId"],
    ["name", "prompt", "execution", "exits"],
    ["agentId", "expectedRevision", "name", "prompt", "execution", "exits"],
    undefined,
    ["flowId"],
    ["name"],
    ["flowId", "expectedRevision", "name", "graph"],
    ["flowId"],
    undefined,
    ["requestId", "projectId", "flowId", "input"],
  ]);
  expect(listed.tools[0]?.inputSchema.properties?.to).toMatchObject({
    enum: ["working", "finished"],
  });
});

it("repairing a Codex entry for another backend address replaces only Factory's entry", async (context) => {
  // Arrange
  const { factory, harness, options, config } = await reportingFixture(context, "codex");
  await writeFile(config, '# keep this comment\nmodel = "sample"\n');
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);
  assert((await factory.installReporting({ targetId: targets.value[0]!.id })).ok);
  await factory.close();
  const moved = await harness.open({ ...options, runtimeBackendUrl: "http://127.0.0.1:4999" });

  // Act
  const result = await moved.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(result.ok);
  expect(result.value.status).toBe("installed");
  const saved = await readFile(config, "utf8");
  expect(saved).toBe(
    '# keep this comment\nmodel = "sample"\n\n[mcp_servers.factory-runtime]\nurl = "http://127.0.0.1:4999/mcp"\n',
  );
});

it("Repair installs the Factory Block skill under the Claude home", async (context) => {
  // Arrange
  const { home, harness } = await installedReportingFixture(context);
  const harnessSkill = join(home, ".claude", "skills", "factory-block", "SKILL.md");
  const canonical = join(harness.processHome, "reporting", "skills", "factory-block", "SKILL.md");

  // Act
  const installed = await readFile(harnessSkill, "utf8");

  // Assert
  expect(installed).toBe(await readFile(canonical, "utf8"));
  expect(installed).toContain("name: factory-block");
  expect(installed).toContain("factory_get_block");
  expect(installed).toContain("factory_get_run");
  expect(installed).toContain("factory_get_run_image");
  expect(installed).toContain('to: "working"');
  expect(installed).toContain('to: "finished"');
  expect(installed).toContain("`blockId`");
  expect(installed).toContain("$factory-block");
});

it("Repair installs the Factory Block skill beside a Codex config", async (context) => {
  // Arrange
  const { factory, home } = await reportingFixture(context, "codex");
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);

  // Act
  const result = await factory.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(result.ok);
  const installed = await readFile(join(home, "skills", "factory-block", "SKILL.md"), "utf8");
  expect(installed).toContain("name: factory-block");
  expect(installed).toContain("$factory-block");
});

it("a missing Factory Block skill stays repairable and Repair rewrites it", async (context) => {
  // Arrange
  const fixture = await installedReportingFixture(context);
  const skill = join(fixture.home, ".claude", "skills", "factory-block", "SKILL.md");
  await rm(skill);
  const before = await fixture.factory.getReportingInstallations();
  assert(before.ok);
  expect(before.value[0]!.status).toBe("needs-attention");
  expect(before.value[0]!.actions.repair).toBe(true);
  expect(before.value[0]!.message).toMatch(/Factory Block skill/);

  // Act
  const result = await fixture.factory.installReporting({ targetId: fixture.targetId });

  // Assert
  assert(result.ok);
  expect(result.value.status).toBe("installed");
  expect(await readFile(skill, "utf8")).toContain("name: factory-block");
});

/** The skill current releases install: it passes a Factory tool ref and has no working report. */
const RELEASED_SKILL = `---
name: factory-block
description: Work one Factory Block with the factory-runtime tools. Use when the thread's first message starts with $factory-block.
---

# Factory Block

This thread is one Block in a Factory Run. Factory takes the Block's result only from its tools, never from chat.

1. Call \`factory_get_block\` before any other work. Done when it returns your Block with its inputs and exits.
2. Work from this Agent's prompt and those inputs. Call \`factory_get_run\` when you need the rest of the Run as context.
3. Report with \`factory_update_block\`. Done when it returns an acknowledgement.
   - \`to: "waiting"\` when you need the user's reply, then end the turn.
   - \`to: "finished"\` with one of the Block's exits when the work is done.

When the message gives a Factory tool ref, pass it as \`ref\` on every Factory tool call. Factory tools belong to this thread's own agent; subagents work without them.

Every later turn in this thread, including feedback and user replies, starts again at step 1.
`;

it("a Factory Block skill installed by an earlier release needs attention until Repair replaces it", async (context) => {
  // Arrange
  const fixture = await installedReportingFixture(context);
  const skill = join(fixture.home, ".claude", "skills", "factory-block", "SKILL.md");
  await writeFile(skill, RELEASED_SKILL);
  const before = await fixture.factory.getReportingInstallations();
  assert(before.ok);
  expect(before.value[0]).toMatchObject({ status: "needs-attention", actions: { repair: true } });

  // Act
  const result = await fixture.factory.installReporting({ targetId: fixture.targetId });

  // Assert
  assert(result.ok);
  expect(result.value.status).toBe("installed");
  expect(await readFile(skill, "utf8")).toContain('to: "working"');
});

it("Grok installation distributes the launch skill while preserving unrelated config", async (context) => {
  // Arrange
  const { factory, home } = await driverHomes(context, { grok: { driver: "grok", config: {} } });
  await mkdir(join(home, ".grok"));
  const config = join(home, ".grok", "config.toml");
  await writeFile(config, '# keep\nmodel = "sample"\n');
  const targets = await factory.getReportingInstallations();
  assert(targets.ok);

  // Act
  const installed = await factory.installReporting({ targetId: targets.value[0]!.id });

  // Assert
  assert(installed.ok);
  expect(installed.value.launchSkill).toBe("current");
  expect(
    await readFile(join(home, ".grok", "skills", "factory-start-run", "SKILL.md"), "utf8"),
  ).toBe(FACTORY_START_RUN_SKILL);
  expect(await readFile(config, "utf8")).toContain('# keep\nmodel = "sample"\n');
});

it("a missing optional skill leaves reporting installed and offers Reinstall", async (context) => {
  // Arrange
  const { factory, home } = await installedReportingFixture(context);
  await rm(join(home, ".claude", "skills", "setup-factory", "SKILL.md"));

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]).toMatchObject({
    status: "installed",
    launchSkill: "missing",
    actions: { reinstall: true },
  });
  expect(result.value[0]!.message).toMatch(/Reinstall and start a fresh session/);
});

it("an outdated harness launch skill leaves reporting installed", async (context) => {
  // Arrange
  const { factory, home } = await installedReportingFixture(context);
  await writeFile(join(home, ".claude", "skills", "factory-start-run", "SKILL.md"), "older skill");

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]).toMatchObject({
    status: "installed",
    launchSkill: "outdated",
    actions: { reinstall: true },
  });
});

it("an outdated canonical optional skill leaves reporting installed", async (context) => {
  // Arrange
  const { factory, harness } = await installedReportingFixture(context);
  await writeFile(
    join(harness.processHome, "reporting", "skills", "setup-factory", "SKILL.md"),
    "older skill",
  );

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]).toMatchObject({
    status: "installed",
    launchSkill: "outdated",
    actions: { reinstall: true },
  });
});

it("Reinstall restores a missing launch skill and updates the outdated canonical copy", async (context) => {
  // Arrange
  const { factory, home, harness, targetId } = await installedReportingFixture(context);
  const skill = join(home, ".claude", "skills", "factory-start-run", "SKILL.md");
  const canonical = join(
    harness.processHome,
    "reporting",
    "skills",
    "factory-start-run",
    "SKILL.md",
  );
  await rm(skill);
  await writeFile(canonical, "older skill");

  // Act
  const result = await factory.installReporting({ targetId });

  // Assert
  assert(result.ok);
  expect(result.value).toMatchObject({ status: "installed", launchSkill: "current" });
  expect(await readFile(skill, "utf8")).toBe(FACTORY_START_RUN_SKILL);
  expect(await readFile(canonical, "utf8")).toBe(FACTORY_START_RUN_SKILL);
});

it("Repair installs required reporting and leaves a symlinked launch skill unchanged with its explanation", async (context) => {
  // Arrange
  const { factory, home, config, targetId } = await installedReportingFixture(context);
  const skill = join(home, ".claude", "skills", "factory-start-run", "SKILL.md");
  const destination = join(home, "unrelated.md");
  await rm(skill);
  await writeFile(destination, "preserve");
  await symlink(destination, skill);
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: { "factory-runtime": { type: "http", url: "http://127.0.0.1:4999/mcp" } },
    }),
  );

  // Act
  const result = await factory.installReporting({ targetId });

  // Assert
  assert(result.ok);
  expect(result.value).toMatchObject({ status: "installed", launchSkill: "outdated" });
  expect(result.value.message).toContain(skill);
  expect(await readFile(destination, "utf8")).toBe("preserve");
  expect(await readFile(config, "utf8")).not.toContain("4999");
});

it("Repair completes when launch-skill copies are FIFOs, without reading them", async (context) => {
  // Arrange
  const { factory, home, harness, config, targetId } = await installedReportingFixture(context);
  const skill = join(home, ".claude", "skills", "factory-start-run", "SKILL.md");
  const canonical = join(
    harness.processHome,
    "reporting",
    "skills",
    "factory-start-run",
    "SKILL.md",
  );
  const fifo = join(home, "launch.fifo");
  execFileSync("mkfifo", [fifo]);
  await rm(skill);
  await symlink(fifo, skill);
  await rm(canonical);
  execFileSync("mkfifo", [canonical]);
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: { "factory-runtime": { type: "http", url: "http://127.0.0.1:4999/mcp" } },
    }),
  );

  // Act
  const result = await factory.installReporting({ targetId });

  // Assert
  assert(result.ok);
  expect(result.value).toMatchObject({ status: "installed", launchSkill: "outdated" });
  expect(result.value.message).toContain("special or hard-linked file");
  expect(await readFile(config, "utf8")).not.toContain("4999");
});

it("an unwritable launch-skill location stays explained after Repair installs reporting", async (context) => {
  // Arrange
  const { factory, home, config, targetId } = await installedReportingFixture(context);
  const directory = join(home, ".claude", "skills", "factory-start-run");
  await rm(join(directory, "SKILL.md"));
  await chmod(directory, 0o500);
  context.onTestFinished(() => chmod(directory, 0o700));
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: { "factory-runtime": { type: "http", url: "http://127.0.0.1:4999/mcp" } },
    }),
  );
  assert((await factory.installReporting({ targetId })).ok);

  // Act
  const result = await factory.getReportingInstallations();

  // Assert
  assert(result.ok);
  expect(result.value[0]).toMatchObject({ status: "installed", launchSkill: "missing" });
  expect(result.value[0]!.message).toContain(`${directory} is not writable`);
});

// A non-root user can lock a file against replacement only with macOS file flags.
it.runIf(process.platform === "darwin")(
  "a launch-skill copy that cannot be replaced keeps its actual failure after Repair installs reporting",
  async (context) => {
    // Arrange
    const { factory, home, config, targetId } = await installedReportingFixture(context);
    const skill = join(home, ".claude", "skills", "factory-start-run", "SKILL.md");
    await writeFile(skill, "older skill");
    execFileSync("chflags", ["uchg", skill]);
    context.onTestFinished(() => {
      execFileSync("chflags", ["nouchg", skill]);
    });
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: { "factory-runtime": { type: "http", url: "http://127.0.0.1:4999/mcp" } },
      }),
    );
    assert((await factory.installReporting({ targetId })).ok);

    // Act
    const result = await factory.getReportingInstallations();

    // Assert
    assert(result.ok);
    expect(result.value[0]).toMatchObject({ status: "installed", launchSkill: "outdated" });
    expect(result.value[0]!.message).toContain(`${skill} could not be replaced`);
    expect(await readFile(skill, "utf8")).toBe("older skill");
    expect(await readFile(config, "utf8")).not.toContain("4999");
  },
);

it("missing optional skills do not block Start", async (context) => {
  // Arrange
  const { f, input } = await prepared(context);
  const targets = await f.getReportingInstallations();
  assert(targets.ok);
  const config = targets.value[0]!.path!;
  await rm(join(config, "..", "skills", "factory-start-run", "SKILL.md"));
  await rm(join(config, "..", "skills", "setup-factory", "SKILL.md"));

  // Act
  const result = await f.startRun(input);

  // Assert
  assert(result.ok);
  expect(result.value.id).toBeTruthy();
});

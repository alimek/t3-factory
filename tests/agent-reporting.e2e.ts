import assert from "node:assert/strict";
import { afterEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { listAgentDefinitions, repairCodexReporting } from "./support/agents.ts";
import { remoteFixture } from "./support/remote-access.ts";

// Later journeys share the fixture's T3 connection.
afterEach(async ({ app }) => {
  await remoteFixture(app, "t3-available");
  await remoteFixture(app, "reporting/optional-skill");
});

test("reporting problems are visible before Start and clear after repairing the provider", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  await app.open("/runs/new");
  const agents = await listAgentDefinitions(app.baseUrl);
  const worker = agents.find((agent) => agent.name === "Runtime worker");
  assert(worker);
  await expect(screen.getByRole("link", "Settings, Connected", { exact: true })).toBeVisible();
  const broken = await fetch(new URL("/__fixture/reporting/break", app.baseUrl), {
    method: "POST",
  });
  assert(broken.ok);

  // Act
  await browser.reload();
  await expect(
    screen.getByRole("link", /^Settings, (Connected|Agent reporting needs attention)$/),
  ).toBeVisible();
  await app.screenshot("settings-reporting-needs-attention");
  await app.open(`/studio/agents/${worker.id}`);

  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue("Runtime worker");
  await expect
    .poll(() =>
      browser.evaluate(`getComputedStyle(document.querySelector('[data-studio]')).opacity`),
    )
    .toBe("1");
  await app.screenshot("agents-reporting-needs-repair");
  await expect(screen.getByRole("status", "Agent reporting status")).toContainText(
    "Reporting needs attention",
  );
  await expect(screen.getByRole("link", "Runtime worker", { exact: true })).toContainText(
    "Reporting needs attention",
  );
  await expect(screen.getByRole("status", "Agent reporting status")).toContainText(
    "Factory Block skill missing or outdated",
  );
  await screen.getByRole("button", "Back to Runs").tap();
  await expect(
    screen.getByRole("link", "Settings, Agent reporting needs attention", { exact: true }),
  ).toBeVisible();
  await app.open(`/studio/agents/${worker.id}`);
  await screen.getByRole("link", "Open Agent reporting").tap();
  await expect(screen.getByRole("heading", "Agent reporting", { exact: true })).toBeVisible();
  await expect(screen.getByRole("group", "Codex", { exact: true }).getByRole("status")).toHaveText(
    "Needs attention",
  );
  await expect(
    screen.getByRole("link", "Agent reporting, Needs attention", { exact: true }),
  ).toBeVisible();
  await repairCodexReporting(screen);

  // Assert
  await expect(screen.getByRole("link", "Settings, Connected", { exact: true })).toBeVisible();
  await app.screenshot("settings-reporting-repaired");
  await app.open(`/studio/agents/${worker.id}`);
  await expect(screen.getByRole("status", "Agent reporting status")).toContainText(
    "Reporting installed",
  );
  await app.screenshot("agents-reporting-installed");
});

test("a failed reporting inspection warns instead of showing green Connected", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.route("**/api/reporting", (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        error: { code: "validation", message: "Reporting inspection unavailable", issues: [] },
      },
    }),
  );

  // Act
  await app.open("/runs/new");

  // Assert
  await expect(
    screen.getByRole("link", "Settings, Reporting status unavailable", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("link", "Settings, Reporting status unavailable", { exact: true }).tap();
  await expect(screen.getByRole("heading", "Agent reporting", { exact: true })).toBeVisible();
  await expect(screen.getByRole("alert")).toContainText("Factory could not check Agent reporting");
});

test("the Agent reporting attention dot clears once every harness is installed", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const codex = {
    id: "codex-home",
    provider: "codex",
    instances: ["codex-main"],
    path: "/home/factory/.codex/config.toml",
    message: "Configuration installed.",
    launchSkill: "current",
    runtimeEvidence: "UNVERIFIED",
  };
  let targets = [
    {
      ...codex,
      status: "not-installed",
      actions: { install: true, repair: false, reinstall: false },
    },
  ];
  await browser.route("**/api/reporting", (route) =>
    route.fulfill({ json: { ok: true, value: targets } }),
  );
  await app.open("/settings/agent-reporting");
  await expect(
    screen.getByRole("link", "Agent reporting, Needs attention", { exact: true }),
  ).toBeVisible();
  targets = [
    { ...codex, status: "installed", actions: { install: false, repair: false, reinstall: true } },
  ];

  // Act
  await screen.getByRole("button", "Check again", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("group", "Codex", { exact: true }).getByRole("status")).toHaveText(
    "Installed",
  );
  await expect(screen.getByRole("link", "Agent reporting", { exact: true })).toBeVisible();
});

test("installed reporting shows the file and manual remedy for a linked optional skill", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  const linked = await remoteFixture(app, "reporting/optional-skill?linked=1");
  assert(linked.ok);
  const { path } = (await linked.json()) as { path: string };

  // Act
  await app.open("/settings/agent-reporting");

  // Assert
  const codex = screen.getByRole("group", "Codex", { exact: true });
  await expect(codex.getByRole("status")).toHaveText("Installed");
  await expect
    .poll(() =>
      browser.evaluate(`getComputedStyle(document.querySelector('[role="dialog"]')).opacity`),
    )
    .toBe("1");
  await app.screenshot("reporting-optional-skill-diagnostic");
  await expect(codex).toContainText(path);
  await expect(codex).toContainText("Replace or remove it manually, then Reinstall.");
});

test("a disconnected T3 connection takes precedence over reporting warnings", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.route("**/api/reporting", (route) =>
    route.fulfill({ json: { ok: true, value: [] } }),
  );
  await remoteFixture(app, "t3-unavailable");

  // Act
  await app.open("/runs/new");

  // Assert
  await expect(screen.getByRole("link", "Settings, Disconnected", { exact: true })).toBeVisible();
  await screen.getByRole("link", "Settings, Disconnected", { exact: true }).tap();
  await expect(screen.getByRole("heading", "T3 connection", { exact: true })).toBeVisible();
});

import assert from "node:assert/strict";
import { afterEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { listAgentDefinitions, repairCodexReporting } from "./support/agents.ts";
import { remoteFixture } from "./support/remote-access.ts";

// Later journeys share the fixture's T3 connection.
afterEach(async ({ app }) => {
  await remoteFixture(app, "t3-available");
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

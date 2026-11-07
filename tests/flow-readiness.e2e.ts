import { repairCodexReporting } from "./support/agents.ts";
import assert from "node:assert/strict";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openComposerWithFlow } from "./support/composer.ts";
import { findRun, readHistoryRun, runsTitled } from "./support/run-history.ts";

test("Start names every blocked Agent including later branches and succeeds after repair", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  await openComposerWithFlow(app, screen, "Demo · Parallel review");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("UI whole Flow readiness");
  const broken = await fetch(new URL("/__fixture/reporting/break", app.baseUrl), {
    method: "POST",
  });
  assert(broken.ok);

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("alert")).toContainText("No Run was created");
  await app.screenshot("whole-flow-blocked");
  await expect(screen.getByRole("list", "Start blockers")).toContainText(
    "Demo · Product engineer:",
  );
  await expect(screen.getByRole("list", "Start blockers")).toContainText("Demo · Code reviewer:");
  await expect(screen.getByRole("list", "Start blockers")).toContainText(
    "Demo · Accessibility reviewer:",
  );
  expect(await runsTitled(app.baseUrl, "UI whole Flow readiness")).toHaveLength(0);
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toHaveValue(
    "UI whole Flow readiness",
  );
  await screen.getByRole("link", "Open Settings → Agent reporting", { exact: true }).tap();
  await repairCodexReporting(screen);
  await expect(screen.getByRole("link", "Settings, Connected", { exact: true })).toBeVisible();
  await app.screenshot("whole-flow-configuration-repaired");
  await screen.getByRole("button", "Start", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "UI whole Flow readiness", { exact: true }),
  ).toBeVisible();
  const created = await findRun(app.baseUrl, "UI whole Flow readiness");
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, created.id)).activations.length)
    .toBe(1);
  await app.screenshot("whole-flow-start-accepted");
  const finished = await fetch(new URL("/__fixture/readiness/report", app.baseUrl), {
    method: "POST",
  });
  assert(finished.ok);
  await browser.reload();
  await expect(screen.getByRole("region", "Block activations")).toContainText("Report accepted");
  const run = await readHistoryRun(app.baseUrl, created.id);
  expect(run.reports[0]?.completionEligibleAt).not.toBe(null);
  expect(run.activations).toHaveLength(3);
  await app.screenshot("whole-flow-result-accepted");
});

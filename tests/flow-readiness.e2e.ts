import { repairCodexReporting } from "./support/agents.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openComposerWithFlow } from "./support/composer.ts";
import { saveFlowCopy } from "./support/flows.ts";
import { findRun, readHistoryRun, runsTitled } from "./support/run-history.ts";

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1100 });
});

afterEach(async ({ app }) => {
  const restored = await fetch(new URL("/__fixture/readiness/restore", app.baseUrl), {
    method: "POST",
  });
  assert(restored.ok);
});

test("Start names every blocked Agent including later branches and succeeds after repair", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
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

test("Agent-scoped runtime contract blockers point to the connection without blaming Agents", async ({
  app,
  screen,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Parallel review");
  await screen
    .getByLabel("Initial prompt", { exact: false })
    .fill("UI incomplete runtime contract");
  const incomplete = await fetch(new URL("/__fixture/readiness/incomplete-runtime", app.baseUrl), {
    method: "POST",
  });
  assert(incomplete.ok);

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("list", "Start blockers")).toContainText(
    "t3_thread_send lacks required runtime fields",
  );
  await expect(
    screen.getByRole("link", "Open T3 connection settings", { exact: true }),
  ).toBeVisible();
  await app.screenshot("connection-only-blocker");
  await expect(screen.getByRole("link", "Open Studio → Agents", { exact: true })).toHaveCount(0);
  expect(await runsTitled(app.baseUrl, "UI incomplete runtime contract")).toHaveLength(0);
});

test("a worktree Flow whose custom base ref is missing blocks Start with a Studio Flow repair link", async ({
  app,
  screen,
}) => {
  // Arrange
  await saveFlowCopy(app.baseUrl, "Demo · Focused change", "Missing base worktree", {
    mode: "worktree",
    base: { kind: "ref", ref: "release/missing" },
  });
  await openComposerWithFlow(app, screen, "Missing base worktree");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("UI missing worktree base");

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("list", "Start blockers")).toContainText(
    "release/missing is not a commit",
  );
  await expect(screen.getByRole("link", "Open Studio → Flows", { exact: true })).toBeVisible();
  await app.screenshot("workspace-base-blocker");
  await expect(screen.getByRole("link", "Open Studio → Agents", { exact: true })).toHaveCount(0);
  expect(await runsTitled(app.baseUrl, "UI missing worktree base")).toHaveLength(0);
});

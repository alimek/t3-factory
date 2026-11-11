import { confirmSettlement } from "./support/run-history.ts";
import { test } from "@e2e-dev/web";
import assert from "node:assert/strict";
import { expect } from "e2e";
import { findRun } from "./support/run-history.ts";
import { prepareScenarios } from "./support/scenarios.ts";
import {
  openSidebarAction,
  expectFlatSearch,
  matchingSidebarTitles,
  prepareSidebarPreview,
} from "./support/sidebar.ts";

const snoozedTitle = "Demo · Snoozed · Navigation research";
const workingTitle = "Demo · Working · Improve the project picker";
// Earlier journeys replace the T3 authorization the Demo Runs started under, and Settle refuses
// such a Run, so Settle journeys use the scenario copy started under the current authorization.
const settleTitle = "UI worker · Snoozed · Navigation research";

test("the Run preview opens to the right of its row", async ({ app, screen, browser }) => {
  // Arrange
  const { row, preview } = await prepareSidebarPreview({ app, screen, browser }, workingTitle);

  // Act
  await row.hover();

  // Assert
  await expect(preview).toBeVisible();
  await app.screenshot("sidebar-row-preview");
  await expect(preview).toHaveAttribute("data-side", "right");
  const rowBox = await row.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(previewBox!.x).toBeGreaterThanOrEqual(rowBox!.x + rowBox!.width);
  const viewportHeight = await browser.evaluate("window.innerHeight");
  assert(typeof viewportHeight === "number");
  const expectedTop = Math.max(8, Math.min(rowBox!.y, viewportHeight - previewBox!.height - 8));
  expect(Math.abs(previewBox!.y - expectedTop)).toBeLessThan(10);
  await expect(row).toContainText("feature/project-picker-empty-state-and-keyboard-navigation");
  await expect(row.getByLabel(/pull requests/)).toHaveCount(0);
  await expect(preview).toContainText("Demo · Focused change");
});

test("opening Run actions dismisses the preview and menu hover keeps it closed", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { row, preview } = await prepareSidebarPreview(
    { app, screen, browser },
    workingTitle,
    true,
  );

  // Act
  await row.secondaryTap();
  await screen.getByRole("menuitem", "Rename", { exact: false }).hover();

  // Assert
  await expect(screen.getByRole("menu")).toBeVisible();
  await app.screenshot("sidebar-row-context-menu");
  await expect(preview).toBeHidden();
});

test("restoring the last snoozed Run hides its group and focuses the restored row", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { toggle, actions } = await openSidebarAction(
    { app, screen, browser },
    snoozedTitle,
    "snooze",
  );
  await app.screenshot("snoozed-before-restore");

  // Act
  await screen.getByRole("menuitem", "Restore", { exact: true }).tap();

  // Assert
  await expect(toggle).toBeHidden();
  await expect(actions).toBeFocused();
  await expect(
    screen.getByRole("navigation", "Open Runs").getByRole("link", /Demo · Snoozed/),
  ).toBeVisible();
  await app.screenshot("snoozed-empty-hidden");
  expect((await findRun(app.baseUrl, snoozedTitle)).presentation.snoozed).toBe(false);
});

test("snoozing a restored Run restores its group expansion and focuses the toggle", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { toggle, actions } = await openSidebarAction(
    { app, screen, browser },
    snoozedTitle,
    "snooze",
  );
  await screen.getByRole("menuitem", "Restore", { exact: true }).tap();
  await expect(toggle).toBeHidden();
  await actions.secondaryTap();

  // Act
  await screen.getByRole("menuitem", "Snooze", { exact: true }).tap();

  // Assert
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    screen.getByRole("navigation", "Snoozed Runs").getByRole("link", /Demo · Snoozed/),
  ).toBeVisible();
  await app.screenshot("snoozed-returned-expanded");
  expect((await findRun(app.baseUrl, snoozedTitle)).presentation.snoozed).toBe(true);
});

test("title search combines drafts and all Run states in creation order", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/runs/new");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("Demo · Sidebar search draft");
  const snoozed = await findRun(app.baseUrl, snoozedTitle);
  await app.open(`/runs/${snoozed.id}`);
  await app.open("/runs/new");
  const titles = await matchingSidebarTitles(app.baseUrl, "Demo ·");

  // Act
  await screen.getByRole("textbox", "Search Run titles").fill("Demo ·");

  // Assert
  const open = screen.getByRole("navigation", "Open Runs");
  await expectFlatSearch(screen);
  await expect(open.getByRole("link")).toHaveCount(titles.length + 1);
  await expect(open.getByRole("link")).toContainText(["Demo · Sidebar search draft", ...titles]);
  await expect(open.getByText(`Runs · ${titles.length + 1}`)).toBeVisible();
  await expect(open.getByRole("link", /Demo · Snoozed/)).toBeVisible();
  await expect(open.getByRole("link", /Demo · Settled/)).toBeVisible();
  await app.screenshot("flat-search-muted-states");
});

test("restore during search keeps focus on the matching row", async ({ app, screen, browser }) => {
  // Arrange
  const { actions } = await openSidebarAction(
    { app, screen, browser },
    snoozedTitle,
    "snooze",
    true,
  );

  // Act
  await screen.getByRole("menuitem", "Restore", { exact: true }).tap();

  // Assert
  await expect(actions).toBeFocused();
  await expectFlatSearch(screen);
  await app.screenshot("search-restore-row-focused");
});

test("snooze during search keeps focus on the matching row", async ({ app, screen, browser }) => {
  // Arrange
  const { actions } = await openSidebarAction(
    { app, screen, browser },
    snoozedTitle,
    "restore",
    true,
  );

  // Act
  await screen.getByRole("menuitem", "Snooze", { exact: true }).tap();

  // Assert
  await expect(actions).toBeFocused();
  await expectFlatSearch(screen);
  await app.screenshot("search-snooze-row-focused");
});

test("settle during search keeps focus on the matching row", async ({ app, screen, browser }) => {
  // Arrange
  await prepareScenarios(app.baseUrl);
  const { actions } = await openSidebarAction(
    { app, screen, browser },
    settleTitle,
    "snooze",
    true,
  );

  // Act
  await screen.getByRole("menuitem", "Settle", { exact: true }).tap();
  await expect(
    screen.getByRole("alertdialog").getByRole("button", "Cancel", { exact: true }),
  ).toBeFocused();
  // The modal hides the underlying controls from the accessibility tree.
  await expect(browser.locator(`button[aria-label="Actions for ${settleTitle}"]`)).toBeEnabled();
  await app.screenshot("settle-confirmation-row-actions-released");
  await confirmSettlement(screen);

  // Assert
  await expect(actions).toBeFocused();
  await expectFlatSearch(screen);
  await app.screenshot("search-settle-row-focused");
});

test("Run rows summarize independent branches and count shared PRs once", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const title = "Demo · Parallel review from one prompt";
  const row = screen
    .getByRole("navigation", "Open Runs")
    .getByRole("link")
    .filter({ hasText: title });

  // Act
  await app.open("/runs/new");

  // Assert
  await expect(row).toContainText("2 branches");
  await expect(row.getByLabel("2 pull requests", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", `Actions for ${title}`)).toBeHidden();
});

test("Run repository details retain branch ownership and PR links after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const title = "Demo · Parallel review from one prompt";
  const { row } = await prepareSidebarPreview({ app, screen, browser }, title);
  await row.tap();
  await expect(screen.getByRole("region", "Run repositories")).toBeVisible();

  // Act
  await browser.reload();

  // Assert
  const repositories = screen.getByRole("region", "Run repositories");
  await expect(repositories).toContainText("review/project-picker");
  await expect(repositories).toContainText("Code review");
  await expect(repositories).toContainText("review/keyboard-accessibility");
  await expect(repositories).toContainText("Accessibility review");
  await expect(
    repositories.getByRole("link", "example/atlas #42", { exact: true }),
  ).toHaveAttribute("href", "https://github.com/example/atlas/pull/42");
  await expect(
    repositories.getByRole("link", "example/atlas #43", { exact: true }),
  ).toHaveAttribute("href", "https://github.com/example/atlas/pull/43");
  await expect(repositories.getByRole("link")).toHaveCount(2);
  await app.screenshot("run-branches-and-pull-requests");
});

test("expanding Settled shows compact single-line rows without repository metadata", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/runs/new");
  const row = screen
    .getByRole("navigation", "Settled Runs")
    .getByRole("link", /Demo · Settled · Clearer onboarding copy/);

  // Act
  await screen.getByRole("button", /^Settled \d+$/).tap();

  // Assert
  await expect(row).toBeVisible();
  const bounds = await row.boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(36);
  await expect(row).not.toContainText("copy/welcome");
  await app.screenshot("sidebar-compact-settled");
});

test("the Settled preview exposes repository details omitted from its compact row", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/runs/new");
  await screen.getByRole("button", /^Settled \d+$/).tap();
  const row = screen
    .getByRole("navigation", "Settled Runs")
    .getByRole("link", /Demo · Settled · Clearer onboarding copy/);

  // Act
  await row.hover();

  // Assert
  const preview = browser.locator('[data-slot="tooltip-content"]');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("copy/welcome");
  await expect(preview).toContainText("example/atlas #41");
  await app.screenshot("sidebar-settled-preview");
});

test("cancelling Rename returns focus with Run state and attention available without a preview", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { row, preview } = await prepareSidebarPreview(
    { app, screen, browser },
    "Demo · Problem · Search checks failed",
  );
  await row.press("Shift+F10");
  await expect(screen.getByRole("menu")).toBeVisible();
  await screen.getByRole("menuitem", "Rename", { exact: false }).tap();
  await expect(screen.getByRole("dialog", "Rename Run")).toBeVisible();
  await expect(screen.getByRole("textbox", "Run title", { exact: true })).toBeFocused();

  // Act
  await screen.getByRole("button", "Cancel", { exact: true }).tap();

  // Assert
  await expect(row).toBeFocused();
  await expect(row).toHaveAccessibleName(
    /Demo · Problem · Search checks failed.*Problem.*,\s*(Waiting|Observation unknown or stale)$/,
  );
  await expect(preview).toBeHidden();
});

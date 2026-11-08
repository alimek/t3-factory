import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun } from "./support/run-history.ts";
import { openSidebarAction, expectFlatSearch, matchingSidebarTitles } from "./support/sidebar.ts";

const snoozedTitle = "Demo · Snoozed · Navigation research";

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
    screen.getByRole("navigation", "Open Runs").getByRole("link", /^Demo · Snoozed/),
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
  await actions.tap();

  // Act
  await screen.getByRole("menuitem", "Snooze", { exact: true }).tap();

  // Assert
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    screen.getByRole("navigation", "Snoozed Runs").getByRole("link", /^Demo · Snoozed/),
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
  await expect(open.getByRole("link", /^Demo · Snoozed/)).toBeVisible();
  await expect(open.getByRole("link", /^Demo · Settled/)).toBeVisible();
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
  const { actions } = await openSidebarAction(
    { app, screen, browser },
    snoozedTitle,
    "snooze",
    true,
  );

  // Act
  await screen.getByRole("menuitem", "Settle", { exact: true }).tap();

  // Assert
  await expect(actions).toBeFocused();
  await expectFlatSearch(screen);
  await app.screenshot("search-settle-row-focused");
});

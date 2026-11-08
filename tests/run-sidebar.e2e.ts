import assert from "node:assert/strict";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Result, RunNavigationEntry } from "../packages/contracts/src/index.ts";
import { findRun } from "./support/run-history.ts";

async function restoreOtherSnoozed(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/run-navigation", baseUrl));
  const navigation = (await response.json()) as Result<readonly RunNavigationEntry[]>;
  assert(navigation.ok);
  for (const run of navigation.value.filter(
    (entry) => entry.presentation.snoozed && entry.title !== snoozedTitle,
  )) {
    const restored = await fetch(new URL(`/api/runs/${run.id}/restore`, baseUrl), {
      method: "POST",
      headers: { "X-Factory-Request": "1" },
    });
    const result = (await restored.json()) as Result<unknown>;
    assert(result.ok);
  }
}

const snoozedTitle = "Demo · Snoozed · Navigation research";

test("restoring the last snoozed Run hides its group and snoozing preserves expansion and focus", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await restoreOtherSnoozed(app.baseUrl);
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/runs/new");
  const toggle = screen.getByRole("button", /^Snoozed 1$/);
  const actions = screen.getByRole("button", `Actions for ${snoozedTitle}`);
  await toggle.tap();
  await actions.tap();
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
  await actions.tap();
  await screen.getByRole("menuitem", "Snooze", { exact: true }).tap();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    screen.getByRole("navigation", "Snoozed Runs").getByRole("link", /^Demo · Snoozed/),
  ).toBeVisible();
  await app.screenshot("snoozed-returned-expanded");
  await browser.reload();
  await expect(toggle).toBeVisible();
  expect((await findRun(app.baseUrl, snoozedTitle)).presentation.snoozed).toBe(true);
});

test("title search combines drafts and all Run states in creation order and keeps action focus on the row", async ({
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
  const response = await fetch(new URL("/api/run-navigation", app.baseUrl));
  const navigation = (await response.json()) as Result<readonly RunNavigationEntry[]>;
  assert(navigation.ok);
  const titles = navigation.value
    .filter((run) => run.title.includes("Demo ·"))
    .toSorted(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        a.creationKey.localeCompare(b.creationKey),
    )
    .map((run) => run.title);

  // Act
  await screen.getByRole("textbox", "Search Run titles").fill("Demo ·");

  // Assert
  const open = screen.getByRole("navigation", "Open Runs");
  await expect(screen.getByRole("button", /^Snoozed \d+$/)).toBeHidden();
  await expect(screen.getByRole("button", /^Settled \d+$/)).toBeHidden();
  await expect(open.getByRole("link")).toHaveCount(titles.length + 1);
  await expect(open.getByRole("link")).toContainText(["Demo · Sidebar search draft", ...titles]);
  await expect(open.getByText(`Runs · ${titles.length + 1}`)).toBeVisible();
  await expect(open.getByRole("link", /^Demo · Snoozed/)).toBeVisible();
  await expect(
    browser.locator('a[href="/runs/' + snoozed.id + '"] span.font-medium').first(),
  ).toHaveAttribute("class", /text-muted-foreground/);
  await expect(browser.locator('a[href="/runs/' + snoozed.id + '"] svg')).toHaveAttribute(
    "class",
    /text-muted-foreground/,
  );
  const settled = await findRun(app.baseUrl, "Demo · Settled · Clearer onboarding copy");
  await expect(browser.locator('a[href="/runs/' + settled.id + '"] svg')).toHaveAttribute(
    "class",
    /lucide-circle-check.*text-muted-foreground/,
  );
  await app.screenshot("flat-search-muted-states");
  const actions = screen.getByRole("button", `Actions for ${snoozedTitle}`);
  await actions.tap();
  await screen.getByRole("menuitem", "Restore", { exact: true }).tap();
  await expect(actions).toBeFocused();
  await expect(
    browser.locator('a[href="/runs/' + snoozed.id + '"] span.font-medium').first(),
  ).toHaveAttribute("class", /text-foreground/);
  await actions.tap();
  await screen.getByRole("menuitem", "Snooze", { exact: true }).tap();
  await expect(actions).toBeFocused();
  await actions.tap();
  await screen.getByRole("menuitem", "Settle", { exact: true }).tap();
  await expect(actions).toBeFocused();
  await expect(screen.getByRole("button", /^Settled \d+$/)).toBeHidden();
  await expect(browser.locator('a[href="/runs/' + snoozed.id + '"] svg')).toHaveAttribute(
    "class",
    /lucide-circle-check.*text-muted-foreground/,
  );
  await app.screenshot("search-settled-row-focused");
  await open.getByRole("link", /^Demo · Snoozed/).tap();
  await expect(open.getByRole("link", /^Demo · Snoozed/)).toHaveAttribute("aria-current", "page");
  await expect(
    browser.locator('a[href="/runs/' + snoozed.id + '"] span.font-medium').first(),
  ).toHaveAttribute("class", /text-foreground/);
  await app.screenshot("search-selected-inactive-row");
});

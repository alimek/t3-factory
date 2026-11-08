import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { matchingSidebarTitles } from "./support/sidebar.ts";
import {
  desktopNewRunHint,
  expectFactoryConnected,
  fillHumanReviewChanges,
  installDesktopBridge,
  openDesktopComposer,
  openKeyboardSettings,
  shortcutMod,
} from "./support/keyboard-shortcuts.ts";
import { workerEvent } from "./support/worker.ts";

const modShiftE = `${shortcutMod}+Shift+E`;
const modSlash = `${shortcutMod}+/`;

beforeEach(async ({ app }) => {
  await workerEvent(app.baseUrl, "prepare");
});

test("palette Enter opens the selected Flow", async ({ app, screen, browser }) => {
  // Arrange
  await app.open("/runs/new");
  await expect(screen.getByRole("heading", /What should we work on/)).toBeVisible();
  await browser.keyboard.press(`${shortcutMod}+k`);
  await screen.getByLabel("Search commands and items").fill("Launch ready Flow");
  await expect(screen.getByRole("option", /Launch ready Flow/)).toBeVisible();

  // Act
  await browser.keyboard.press("Enter");

  // Assert
  await expect(screen.getByRole("dialog", "Command palette")).toBeHidden();
  await expect(screen.getByLabel("Flow name")).toHaveValue("Launch ready Flow");
});

test("Mod+, from dirty Studio opens the unsaved-changes guard", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/runs/new");
  await expectFactoryConnected(screen);
  await browser.keyboard.press(`${shortcutMod}+Shift+s`);
  await screen.getByRole("heading", "Launch ready Flow", { exact: true }).tap();
  await screen.getByLabel("Flow name").fill("Launch ready Flow dirty");

  // Act
  await browser.keyboard.press(`${shortcutMod}+,`);

  // Assert
  await expect(screen.getByRole("dialog", "Discard unsaved Flow changes?")).toBeVisible();
  await screen.getByRole("button", "Keep editing", { exact: true }).tap();
  await expect(screen.getByLabel("Flow name")).toHaveValue("Launch ready Flow dirty");
});

test("Mod+, opens connection Settings without losing the composer draft", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/runs/new");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("Keyboard settings draft");
  await expect(screen.getByRole("link", "Settings, Connected", { exact: true })).toBeVisible();

  // Act
  await browser.keyboard.press(`${shortcutMod}+,`);

  // Assert
  await expect(screen.getByRole("heading", "T3 connection", { exact: true })).toBeVisible();
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toHaveValue(
    "Keyboard settings draft",
  );
});

test("the fake desktop bridge enables Mod+N for New Run", async ({ app, screen, browser }) => {
  // Arrange
  await installDesktopBridge(browser);
  const openRun = await findRun(app.baseUrl, "UI worker · Working · Improve the project picker");
  await app.open(`/runs/${openRun.id}`);
  await expectFactoryConnected(screen);

  // Act
  await browser.keyboard.press(`${shortcutMod}+n`);

  // Assert
  await expect(screen.getByRole("heading", /What should we work on/)).toBeVisible();
});

test("Settings Reset restores the desktop default for New Run", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openDesktopComposer(app, screen, browser);
  await openKeyboardSettings(screen, browser);
  const newRunGroup = screen.getByRole("group", "New Run");
  await newRunGroup.getByRole("button", "Change New Run").tap();
  await browser.keyboard.press(`${shortcutMod}+Shift+n`);
  await screen.getByRole("button", "Save shortcut").tap();
  await expect(newRunGroup).toContainText("Shift");

  // Act
  await newRunGroup.getByRole("button", "Reset New Run").tap();

  // Assert
  await expect(newRunGroup).toContainText(desktopNewRunHint);
  await app.screenshot("keyboard-settings-desktop-defaults");
});

test("desktop Mod+1 opens the first search-filtered visible sidebar row", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await installDesktopBridge(browser);
  await browser.setViewport({ width: 1440, height: 1100 });
  const target = await findRun(app.baseUrl, "UI worker · Parallel review from one prompt");
  const query = target.title;
  const matches = await matchingSidebarTitles(app.baseUrl, query);
  expect(matches[0]).toBe(target.title);
  await app.open("/runs/new");
  await expectFactoryConnected(screen);
  await screen.getByRole("textbox", "Search Run titles").fill(query);

  // Act
  await browser.keyboard.press(`${shortcutMod}+1`);

  // Assert
  await expect(browser).toHaveURL(`/runs/${target.id}`);
});

test("Settle from an editable field on open Run detail while Mod+ shortcuts stay active", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  // Spec #77 names the Run composer; open Run detail has no composer, so focus stays in the Human answer field.
  await installDesktopBridge(browser);
  const found = await findRun(app.baseUrl, "UI worker · Waiting for your review");
  await app.open(`/runs/${found.id}`);
  await expectFactoryConnected(screen);
  await fillHumanReviewChanges(screen, "Keyboard shortcut settle probe");

  // Act
  await browser.keyboard.press(modShiftE);

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).lifecycle)
    .toBe("settled");
  await expect(screen.getByRole("status", "Run observation")).toContainText("Settled");
});

test("Settle is ignored while Settings is open", async ({ app, screen, browser }) => {
  // Arrange
  await installDesktopBridge(browser);
  const title = "UI worker · Two reviewers working in parallel";
  const active = await findRun(app.baseUrl, title);
  await app.open(`/runs/${active.id}`);
  await expectFactoryConnected(screen);
  await openKeyboardSettings(screen, browser);

  // Act
  await browser.keyboard.press(modShiftE);

  // Assert
  await expect(screen.getByRole("heading", { name: "Keyboard shortcuts", level: 2 })).toBeVisible();
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, active.id)).lifecycle)
    .toBe("active");
});

test("Mod+Backspace opens the existing Archive confirmation for the open Run", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await installDesktopBridge(browser);
  const title = "UI worker · Parallel review from one prompt";
  const found = await findRun(app.baseUrl, title);
  await app.open(`/runs/${found.id}`);
  await expectFactoryConnected(screen);

  // Act
  await browser.keyboard.press(`${shortcutMod}+Backspace`);

  // Assert
  const confirmation = screen.getByRole("dialog", `Archive “${title}”?`);
  await expect(confirmation).toContainText("cannot be restored");
  await confirmation.getByRole("button", "Cancel", { exact: true }).tap();
  await expect(confirmation).toBeHidden();
  expect((await readHistoryRun(app.baseUrl, found.id)).lifecycle).toBe("active");
});

test("Mod+/ opens the shortcuts cheat sheet with current hints and a Settings link", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openDesktopComposer(app, screen, browser);

  // Act
  await browser.keyboard.press(modSlash);

  // Assert
  const sheet = screen.getByRole("dialog", "Keyboard shortcuts");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("New Run")).toBeVisible();
  await expect(sheet.getByText(desktopNewRunHint)).toBeVisible();
  await expect(sheet.getByRole("link", "Open Settings → Keyboard shortcuts")).toBeVisible();
  await app.screenshot("shortcuts-cheat-sheet-desktop");
});

test("the shortcuts cheat sheet does not open over the command palette", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await installDesktopBridge(browser);
  await app.open("/runs/new");
  await expectFactoryConnected(screen);
  await browser.keyboard.press(`${shortcutMod}+k`);
  await expect(screen.getByRole("dialog", "Command palette")).toBeVisible();

  // Act
  await browser.keyboard.press(modSlash);

  // Assert
  await expect(screen.getByRole("dialog", "Command palette")).toBeVisible();
  await expect(screen.getByRole("dialog", "Keyboard shortcuts")).toBeHidden();
});

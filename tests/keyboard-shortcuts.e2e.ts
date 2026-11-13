import { confirmSettlement } from "./support/run-history.ts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { matchingSidebarTitles } from "./support/sidebar.ts";
import { elapse } from "./support/remote-access.ts";
import {
  desktopNewRunHint,
  expectFactoryConnected,
  fillHumanReviewChanges,
  installDesktopBridge,
  openDesktopComposer,
  openKeyboardSettings,
  recordDesktopNewRunCandidate,
  shortcutMod,
} from "./support/keyboard-shortcuts.ts";

const modShiftE = `${shortcutMod}+Shift+E`;
const modSlash = `${shortcutMod}+/`;

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
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toHaveText(
    "Keyboard settings draft",
  );
});

test("Tab moves from the composer prompt through Project, Flow and image attachment to Start", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/runs/new");
  await screen.getByLabel("Initial prompt", { exact: false }).tap();
  // Each control that receives focus from here on is numbered in the order it was reached.
  await browser.evaluate(`(() => {
    let reached = 0;
    document.addEventListener("focusin", (event) => {
      event.target.setAttribute("data-focus-order", String(++reached));
    });
  })()`);

  // Act
  await browser.keyboard.press("Tab");
  await browser.keyboard.press("Tab");
  await browser.keyboard.press("Tab");
  await browser.keyboard.press("Tab");

  // Assert
  await expect(screen.getByRole("button", "Start", { exact: true })).toBeFocused();
  await expect(screen.getByRole("button", /^Select project: /)).toHaveAttribute(
    "data-focus-order",
    "1",
  );
  await expect(screen.getByRole("button", /^Select Flow: /)).toHaveAttribute(
    "data-focus-order",
    "2",
  );
  await expect(screen.getByRole("button", "Attach images", { exact: true })).toHaveAttribute(
    "data-focus-order",
    "3",
  );
  await expect(screen.getByRole("button", "Start", { exact: true })).toHaveAttribute(
    "data-focus-order",
    "4",
  );
});

test("the fake desktop bridge enables Mod+N for New Run", async ({ app, screen, browser }) => {
  // Arrange
  await installDesktopBridge(browser);
  const openRun = await findRun(app.baseUrl, "Demo · Working · Improve the project picker");
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
  const newRunGroup = await recordDesktopNewRunCandidate(app, screen, browser);
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
  const target = await findRun(app.baseUrl, "Demo · Parallel review from one prompt");
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
  const found = await findRun(app.baseUrl, "Demo · Waiting for your review");
  await app.open(`/runs/${found.id}`);
  await expectFactoryConnected(screen);
  await fillHumanReviewChanges(screen, "Keyboard shortcut settle probe");

  // Act
  await browser.keyboard.press(modShiftE);

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).lifecycle)
    .toBe("settled");
  await expect(screen.getByRole("status", "Run status")).toContainText("Settled");
});

test("Settle is ignored while Settings is open", async ({ app, screen, browser }) => {
  // Arrange
  await installDesktopBridge(browser);
  const title = "Demo · Two reviewers working in parallel";
  const active = await findRun(app.baseUrl, title);
  await app.open(`/runs/${active.id}`);
  await expectFactoryConnected(screen);
  await openKeyboardSettings(screen, browser);

  // Act
  await browser.keyboard.press(modShiftE);

  // Assert
  await expect(screen.getByRole("heading", { name: "Keyboard shortcuts", level: 2 })).toBeVisible();
  // Observe beyond the key event so an accidental asynchronous Settle cannot pass on the initial state.
  await elapse(1_000);
  expect((await readHistoryRun(app.baseUrl, active.id)).lifecycle).toBe("active");
});

test("Mod+Backspace opens the existing Archive confirmation for the open Run", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await installDesktopBridge(browser);
  const title = "Demo · Parallel review from one prompt";
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
  await expect(sheet.getByText("Follow active", { exact: true })).toBeVisible();
  await expect(sheet.getByText(".", { exact: true })).toBeVisible();
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

test("a customized binding reaches the desktop menu", async ({ app, screen, browser }) => {
  // Arrange
  await recordDesktopNewRunCandidate(app, screen, browser);

  // Act
  await screen.getByRole("button", "Save shortcut").tap();

  // Assert
  await expect
    .poll(() => browser.evaluate("window.__desktopMenu.newRun.binding"))
    .toEqual({ key: "n", mod: true, alt: false, shift: true });
});

test("the desktop menu enables Run actions once an active Run is open", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openDesktopComposer(app, screen, browser);
  const active = await findRun(app.baseUrl, "Demo · Two reviewers working in parallel");
  await expect.poll(() => browser.evaluate("window.__desktopMenu.settle.enabled")).toBe(false);

  // Act
  await app.open(`/runs/${active.id}`);

  // Assert
  await expect.poll(() => browser.evaluate("window.__desktopMenu.settle.enabled")).toBe(true);
});

test("choosing Settle in the desktop menu settles the open Run", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await installDesktopBridge(browser);
  const found = await findRun(app.baseUrl, "Demo · Applying your requested changes");
  await app.open(`/runs/${found.id}`);
  await expectFactoryConnected(screen);
  await expect.poll(() => browser.evaluate("window.__desktopMenu.settle.enabled")).toBe(true);

  // Act
  await browser.evaluate(`window.__chooseMenuItem("settle")`);
  await confirmSettlement(screen);

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).lifecycle)
    .toBe("settled");
});

test("the canvas shortcuts popover lists a customized binding and opens the cheat sheet", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1000 });
  const openRun = await findRun(app.baseUrl, "Demo · Working · Improve the project picker");
  await app.open(`/runs/${openRun.id}`);
  await expectFactoryConnected(screen);
  await openKeyboardSettings(screen, browser);
  await screen.getByRole("group", "Zoom in").getByRole("button", "Change Zoom in").tap();
  await browser.keyboard.press("i");
  await screen.getByRole("button", "Save shortcut").tap();
  await browser.keyboard.press("Escape");
  await expect(screen.getByRole("heading", { name: "Keyboard shortcuts", level: 2 })).toBeHidden();
  await screen.getByRole("button", "Canvas shortcuts", { exact: true }).tap();
  const popover = screen.getByRole("dialog", "Canvas shortcuts");
  await expect(popover).toContainText("Zoom in I");
  await expect(popover).toContainText("Follow active .");
  await expect(popover).toContainText("Pan ← ↑ → ↓");
  await app.screenshot("canvas-shortcuts-popover-customized");

  // Act
  await popover.getByRole("button", "All keyboard shortcuts", { exact: true }).tap();

  // Assert
  const sheet = screen.getByRole("dialog", "Keyboard shortcuts");
  await expect(sheet).toBeVisible();
  await expect(popover).toBeHidden();
  await expect(sheet).toContainText("Zoom in I");
  await expect(sheet).toContainText("Pan ← ↑ → ↓");
});

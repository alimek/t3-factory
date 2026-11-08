import { expect, type App, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import { desktopBridgeScript } from "./desktop-bridge.ts";

export const shortcutMod = process.platform === "darwin" ? "Meta" : "Control";
export const desktopNewRunHint = process.platform === "darwin" ? "⌘N" : "Ctrl+N";

export async function installDesktopBridge(browser: Browser) {
  await browser.addInitScript(desktopBridgeScript("client"));
}

export async function expectFactoryConnected(screen: Screen) {
  await expect(screen.getByRole("status", "Offline")).toHaveCount(0);
  await expect(screen.getByRole("link", "Settings, Connected", { exact: true })).toBeVisible();
}

export async function openKeyboardSettings(screen: Screen, browser: Browser) {
  await browser.keyboard.press(`${shortcutMod}+,`);
  await screen.getByRole("link", "Keyboard shortcuts", { exact: true }).tap();
  await expect(screen.getByRole("heading", { name: "Keyboard shortcuts", level: 2 })).toBeVisible();
}

/** Desktop bridge, 1440×1100, and a connected composer page for keyboard journeys. */
export async function openDesktopComposer(app: App, screen: Screen, browser: Browser) {
  await installDesktopBridge(browser);
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/runs/new");
  await expectFactoryConnected(screen);
}

/** Records Mod+Shift+N for New Run in Settings on a desktop composer, before Save. */
export async function recordDesktopNewRunCandidate(app: App, screen: Screen, browser: Browser) {
  await openDesktopComposer(app, screen, browser);
  await openKeyboardSettings(screen, browser);
  const newRunGroup = screen.getByRole("group", "New Run");
  await newRunGroup.getByRole("button", "Change New Run").tap();
  await browser.keyboard.press(`${shortcutMod}+Shift+n`);
  return newRunGroup;
}

export async function fillHumanReviewChanges(screen: Screen, message: string) {
  const answer = screen.getByRole("form", "Answer Your review", { exact: true });
  await answer.getByRole("combobox", "Exit").selectOption({ label: "Request changes" });
  await answer.getByRole("textbox", "Requested changes").fill(message);
  return answer;
}

import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { desktopBridgeOptions, desktopBridgeScript } from "./support/desktop-bridge.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";

beforeEach(async ({ app }) => {
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
});

test("a desktop user turns on the menu bar icon, which is off by default, in Desktop app settings", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.addInitScript(desktopBridgeScript, desktopBridgeOptions("client"));
  await openApproved(app, "/settings/desktop");
  await expect(screen.getByRole("heading", "Desktop app")).toBeVisible();
  await expect(screen.getByRole("switch", "Show Factory in the menu bar")).not.toBeChecked();
  await app.screenshot("settings-desktop-app-menu-bar-off");

  // Act
  await screen.getByRole("switch", "Show Factory in the menu bar").tap();

  // Assert: the stand-in bridge publishes the stored choice like the desktop shell.
  await expect(screen.getByRole("switch", "Show Factory in the menu bar")).toBeChecked();
  await app.screenshot("settings-desktop-app-menu-bar-on");
});

import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { desktopBridgeOptions, desktopBridgeScript } from "./support/desktop-bridge.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";

beforeEach(async ({ app }) => {
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
});

test("a desktop user turns on the menu bar icon, which is off by default, in General settings", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.addInitScript(desktopBridgeScript, desktopBridgeOptions("client"));
  await openApproved(app, "/settings/general");
  await expect(screen.getByRole("heading", "General")).toBeVisible();
  await expect(screen.getByRole("checkbox", "Show Factory in the menu bar")).not.toBeChecked();
  await app.screenshot("settings-general-menu-bar-off");

  // Act
  await screen.getByRole("checkbox", "Show Factory in the menu bar").tap();

  // Assert: the stand-in bridge publishes the stored choice like the desktop shell.
  await expect(screen.getByRole("checkbox", "Show Factory in the menu bar")).toBeChecked();
  await app.screenshot("settings-general-menu-bar-on");
});

test("a browser profile has no General settings because it has no menu bar icon", async ({
  app,
  screen,
}) => {
  // Act
  await openApproved(app, "/settings/general");

  // Assert
  await expect(screen.getByRole("navigation", "Settings sections")).toBeVisible();
  await expect(screen.getByRole("link", "General")).toHaveCount(0);
});

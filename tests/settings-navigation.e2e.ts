import { test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import { desktopBridgeOptions, desktopBridgeScript } from "./support/desktop-bridge.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";

const sections = (screen: Screen) => screen.getByRole("navigation", "Settings sections");

test("the desktop host lists every Settings section under Factory, Runs and This device", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.addInitScript(desktopBridgeScript, desktopBridgeOptions("server"));

  // Act
  await app.open("/settings/connection");

  // Assert
  const factory = sections(screen).getByRole("group", "Factory");
  await expect(factory.getByRole("link", /^T3 connection, /)).toBeVisible();
  await expect(factory.getByRole("link", /^Agent reporting/)).toBeVisible();
  await expect(factory.getByRole("link", /^Devices & access/)).toBeVisible();
  const runs = sections(screen).getByRole("group", "Runs");
  await expect(runs.getByRole("link", "Run titles", { exact: true })).toBeVisible();
  await expect(runs.getByRole("link", "Run images", { exact: true })).toBeVisible();
  const device = sections(screen).getByRole("group", "This device");
  await expect(device.getByRole("link", "Appearance", { exact: true })).toBeVisible();
  await expect(device.getByRole("link", "Keyboard shortcuts", { exact: true })).toBeVisible();
  await expect(device.getByRole("link", "Desktop app", { exact: true })).toBeVisible();
  await app.screenshot("settings-navigation-desktop-host");
});

test("a browser on the Factory host lists no Desktop app section", async ({ app, screen }) => {
  // Act
  await app.open("/settings/connection");

  // Assert
  await expect(sections(screen).getByRole("link", /^Devices & access/)).toBeVisible();
  await expect(sections(screen).getByRole("link", "Appearance")).toBeVisible();
  await expect(sections(screen).getByRole("link", "Desktop app")).toHaveCount(0);
});

test("a remote client lists neither Devices & access nor Desktop app and locks Run titles", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");

  // Act
  await openApproved(app, "/settings/connection");

  // Assert
  await expect(
    sections(screen).getByRole("link", "Run titles, Managed on the Factory host", { exact: true }),
  ).toBeVisible();
  await expect(sections(screen).getByRole("link", "Appearance")).toBeVisible();
  await expect(sections(screen).getByRole("link", /^Devices & access/)).toHaveCount(0);
  await expect(sections(screen).getByRole("link", "Desktop app")).toHaveCount(0);
  await app.screenshot("settings-navigation-remote-client");
});

test("a removed Settings path opens the default T3 connection section", async ({ app, screen }) => {
  // Act
  await app.open("/settings/application");

  // Assert
  await expect(sections(screen).getByRole("link", /^T3 connection, /)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(screen.getByRole("heading", "Application")).toHaveCount(0);
});

test("Esc in a filled Settings search clears it and keeps Settings open", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/settings/connection");
  await screen.getByLabel("Search settings").fill("RUN");
  await expect(sections(screen).getByRole("link", "Run titles")).toBeVisible();
  await expect(sections(screen).getByRole("link", "Appearance")).toHaveCount(0);

  // Act
  await browser.keyboard.press("Escape");

  // Assert
  await expect(screen.getByLabel("Search settings")).toHaveValue("");
  await expect(sections(screen).getByRole("link", "Appearance")).toBeVisible();
  await expect(screen.getByRole("dialog", "Settings", { exact: true })).toBeVisible();
});

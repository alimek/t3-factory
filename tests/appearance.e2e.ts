import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  openApproved,
  openIncompatibleApplicationSettings,
  remoteFixture,
} from "./support/remote-access.ts";

const documentAppearance = `document.documentElement.dataset.appearance`;
const canvasColor = `getComputedStyle(document.body).backgroundColor`;

test("a browser profile's Light choice survives reload and is applied before the app renders", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange: record the mode when parsing reaches <body>, before any module script runs.
  await browser.addInitScript(() => {
    const record = new MutationObserver(() => {
      if (!document.body) return;
      sessionStorage.setItem("appearanceAtBody", document.documentElement.dataset.appearance!);
      sessionStorage.setItem(
        "themeColorAtBody",
        document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content,
      );
      record.disconnect();
    });
    record.observe(document, { childList: true, subtree: true });
  });
  await app.open("/settings/appearance");
  expect(await browser.evaluate(documentAppearance)).toBe("dark");
  await screen.getByRole("radio", "Light").tap();

  // Act
  await browser.reload();

  // Assert
  await expect(screen.getByRole("radio", "Light")).toBeChecked();
  expect(await browser.evaluate(`sessionStorage.getItem("appearanceAtBody")`)).toBe("light");
  expect(await browser.evaluate(`sessionStorage.getItem("themeColorAtBody")`)).toBe("#ffffff");
  expect(await browser.evaluate(canvasColor)).toBe("rgb(255, 255, 255)");
  expect(
    await browser.evaluate(`document.querySelector('meta[name="theme-color"]').content`),
  ).toMatch(/^#fff(fff)?$/);
  await app.screenshot("appearance-light-after-reload");
});

test("an offline client switches appearance without its server", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await remoteFixture(app, "online");
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
  await openApproved(app, "/runs/new");
  await remoteFixture(app, "offline");
  await expect(screen.getByRole("status", "Offline")).toBeVisible({ timeout: 15_000 });
  await screen.getByRole("link", /^Settings,/).tap();
  await screen.getByRole("link", "Appearance", { exact: true }).tap();

  // Act
  await screen.getByRole("radio", "Light").tap();

  // Assert
  await expect.poll(() => browser.evaluate(documentAppearance)).toBe("light");
  // The Settings dialog hides the banner from the accessibility tree; it is still shown.
  expect(await browser.evaluate(`!!document.querySelector('[aria-label="Offline"]')`)).toBe(true);
  await app.screenshot("appearance-offline-light");
  await remoteFixture(app, "online");
});

test("an incompatible server's gate offers the appearance choice in local application settings", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await remoteFixture(app, "online");
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
  await openIncompatibleApplicationSettings(app, screen);

  // Act
  await screen.getByRole("radio", "Light").tap();

  // Assert
  await expect.poll(() => browser.evaluate(documentAppearance)).toBe("light");
  await expect(screen.getByRole("dialog", "Local application settings")).toBeVisible();
  await app.screenshot("appearance-gate-light");
  await remoteFixture(app, "compatible");
});

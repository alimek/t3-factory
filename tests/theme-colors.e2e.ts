import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { themeColors } from "./support/theme-colors.ts";

const canvasColor = `getComputedStyle(document.body).backgroundColor`;
/** T3's built-in Ocean theme as Factory maps its canvas, per mode. */
const oceanDark = "rgb(23, 33, 43)";
const oceanLight = "rgb(245, 247, 248)";
const factoryDark = "rgb(9, 9, 11)";

test("pairing on the host makes Factory follow the T3 environment's default theme", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const colors = themeColors(app);
  await colors.reset();
  await app.open("/settings/connection");
  await screen.getByRole("button", "Pair theme colors").tap();
  await expect(screen.getByText("This grant reads more than colors")).toBeVisible();
  await screen.getByLabel("Pairing code or link").fill(await colors.pairingCode());

  // Act
  await screen.getByRole("button", "Pair", { exact: true }).tap();

  // Assert
  await expect(screen.getByText("Following T3’s default theme “Ocean”.")).toBeVisible();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);
  await expect(screen.getByRole("button", "Disconnect theme colors")).toBeVisible();
  await app.screenshot("theme-colors-host-paired-dark");
  await colors.reset();
});

test("two clients show the same T3 theme in their own Light and Dark modes", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange: the host panel keeps Dark; an approved browser profile at another address opens.
  const colors = themeColors(app);
  await colors.reset();
  await colors.pair();
  await app.open("/settings/application");
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);
  await app.screenshot("theme-colors-client-one-dark");
  await app.open(colors.otherAddress("/__fixture/remote-browser"));
  await app.open(colors.otherAddress("/__fixture/approved-browser?next=/settings/application"));
  await expect(screen.getByText("Colors follow T3’s default theme “Ocean”.")).toBeVisible();

  // Act
  await screen.getByRole("radio", "Light").tap();

  // Assert
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanLight);
  await app.screenshot("theme-colors-client-two-light");
  await app.open("/settings/application");
  await expect(screen.getByRole("radio", "Dark")).toBeChecked();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);
  await colors.reset();
});

test("a grant T3 revoked without closing its socket ends inheritance and asks to pair again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const colors = themeColors(app);
  await colors.reset();
  await colors.pair();
  await app.open("/settings/connection");
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);

  // Act
  await colors.revoke();

  // Assert
  await expect(
    screen.getByText("T3 no longer accepts the theme-color grant", { exact: false }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(screen.getByRole("button", "Pair again")).toBeVisible();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(factoryDark);
  await app.screenshot("theme-colors-revoked-baseline");
  await colors.reset();
});

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { delayLiveSnapshots } from "./support/live.ts";
import { remoteFixture } from "./support/remote-access.ts";
import {
  cachedSnapshot,
  canvasColor,
  clientWithCachedOcean,
  hostFollowingOcean,
  oceanDark,
  themeColors,
} from "./support/theme-colors.ts";

const oceanLight = "rgb(245, 247, 248)";
const factoryDark = "rgb(9, 9, 11)";
const factoryLight = "rgb(255, 255, 255)";
/** The canvases of the published themes: Nightfall's dark seed, and Dusk's seed and Light variant. */
const nightfallDark = "rgb(20, 18, 31)";
const duskLight = "rgb(255, 248, 235)";
/** The Settings dialog hides the banner behind it from the accessibility tree. */
const offlineBannerShown = `document.querySelector('[role="status"][aria-label="Offline"]') !== null`;
/** Longer than any journey: a reopened page gets no live theme colors while it is set. */
const noLiveDeliveryMs = 600_000;

test("pairing on the host makes Factory follow the T3 environment's default theme", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const colors = themeColors(app);
  await colors.reset();
  await app.open("/settings/appearance");
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
  const colors = await hostFollowingOcean({ app, browser });
  await app.screenshot("theme-colors-client-one-dark");
  await colors.openApprovedClient(screen);

  // Act
  await screen.getByRole("radio", "Light").tap();

  // Assert
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanLight);
  await app.screenshot("theme-colors-client-two-light");
  await app.open("/settings/appearance");
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
  const colors = await hostFollowingOcean({ app, browser });

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

test("a published T3 theme generated from canvas and accent seeds colors Factory in Dark", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const colors = themeColors(app);
  await colors.pairWithPublishedThemes();
  await app.open("/settings/appearance");
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);

  // Act
  await colors.setDefaultTheme("nightfall");

  // Assert
  await expect(screen.getByText("Following T3’s default theme “Nightfall”.")).toBeVisible();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(nightfallDark);
  await app.screenshot("theme-colors-published-seed-dark");
  await colors.reset();
});

test("a published theme without a Light variant keeps Factory's Light colors and says why", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange: an approved browser profile at another address, so the host panel keeps Dark.
  const colors = themeColors(app);
  await colors.followNightfallInApprovedBrowser();
  await screen.getByRole("radio", "Dark").tap();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(nightfallDark);

  // Act
  await screen.getByRole("radio", "Light").tap();

  // Assert
  await expect(
    screen.getByText("T3 theme “Nightfall” has no Light colors. Factory’s Light colors are used."),
  ).toBeVisible();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(factoryLight);
  await app.screenshot("theme-colors-published-missing-light-variant");
  await colors.reset();
});

test("a published theme's Light variant colors Factory in Light", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange: the approved browser profile at the other address shows Light.
  const colors = themeColors(app);
  await colors.followNightfallInApprovedBrowser();
  await screen.getByRole("radio", "Light").tap();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(factoryLight);

  // Act
  await colors.setDefaultTheme("dusk");

  // Assert
  await expect(screen.getByText("Colors follow T3’s default theme “Dusk”.")).toBeVisible();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(duskLight);
  await app.screenshot("theme-colors-published-light-variant");
  await colors.reset();
});

test("a default theme in a format Factory does not support returns to Factory's colors with a diagnostic", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const colors = themeColors(app);
  await colors.pairWithPublishedThemes();
  await colors.setDefaultTheme("nightfall");
  await app.open("/settings/appearance");
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(nightfallDark);

  // Act
  await colors.setDefaultTheme("future");

  // Assert
  await expect(
    screen.getByText(
      "T3’s default theme “Future” uses a theme format Factory does not support, so Factory’s own colors are used.",
    ),
  ).toBeVisible();
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(factoryDark);
  await app.screenshot("theme-colors-published-unsupported-format");
  await colors.reset();
});

test("an approved client reopening before live delivery answers shows its cached T3 theme", async (journey) => {
  // Arrange
  const { app, browser } = journey;
  const { colors, appearance } = await clientWithCachedOcean(journey);
  await delayLiveSnapshots(app, noLiveDeliveryMs);

  // Act
  await app.open(appearance);

  // Assert
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);
  await app.screenshot("theme-colors-cached-reopen-dark");
  await delayLiveSnapshots(app, 0);
  await colors.reset();
});

test("an offline client switches Light and Dark immediately within the T3 theme it holds", async (journey) => {
  // Arrange
  const { app, screen, browser } = journey;
  const { colors } = await clientWithCachedOcean(journey);
  await remoteFixture(app, "offline");
  await expect.poll(() => browser.evaluate(offlineBannerShown)).toBe(true);

  // Act
  await screen.getByRole("radio", "Light").tap();

  // Assert
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanLight);
  await app.screenshot("theme-colors-offline-light");
  await screen.getByRole("radio", "Dark").tap();
  await remoteFixture(app, "online");
  await colors.reset();
});

test("a client whose Factory access was revoked keeps no cached theme", async (journey) => {
  // Arrange
  const { app, screen, browser } = journey;
  const { colors, appearance } = await clientWithCachedOcean(journey);
  await remoteFixture(app, "revoke");

  // Act
  await app.open(appearance);

  // Assert
  await expect(screen.getByRole("heading", "Access was revoked")).toBeVisible();
  expect(await browser.evaluate(canvasColor)).toBe(factoryDark);
  await expect.poll(() => browser.evaluate(cachedSnapshot)).toBe(null);
  await app.screenshot("theme-colors-access-revoked-baseline");
  await colors.reset();
});

test("a theme-color grant T3 revoked leaves a reopening client nothing to restore", async (journey) => {
  // Arrange
  const { app, browser } = journey;
  const { colors, appearance } = await clientWithCachedOcean(journey);
  await colors.revoke();
  await expect.poll(() => browser.evaluate(canvasColor), { timeout: 15_000 }).toBe(factoryDark);
  await delayLiveSnapshots(app, noLiveDeliveryMs);

  // Act
  await app.open(appearance);

  // Assert
  expect(await browser.evaluate(cachedSnapshot)).toBe(null);
  expect(await browser.evaluate(canvasColor)).toBe(factoryDark);
  await delayLiveSnapshots(app, 0);
  await colors.reset();
});

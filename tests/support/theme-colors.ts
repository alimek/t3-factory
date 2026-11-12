import { expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";

type FixtureApp = { baseUrl: string | undefined; open(path: string): Promise<unknown> };

export const canvasColor = `getComputedStyle(document.body).backgroundColor`;
/** T3's built-in Ocean theme as Factory maps its Dark canvas. */
export const oceanDark = "rgb(23, 33, 43)";
/** The theme-color snapshot this browser profile keeps for its Factory address. */
export const cachedSnapshot = `window.localStorage.getItem("factory.inherited-colors")`;

/** Theme-color state of the fixture host's controlled T3, and a second browser address. */
export function themeColors(app: FixtureApp) {
  const post = (action: string) =>
    fetch(new URL(`/__fixture/appearance/${action}`, app.baseUrl), { method: "POST" });
  const otherAddress = (path: string) => {
    const url = new URL(path, app.baseUrl);
    url.hostname = "localhost";
    return url.href;
  };
  return {
    reset: () => post("reset"),
    pair: () => post("pair"),
    revoke: () => post("revoke"),
    /**
     * A paired host whose T3 owner published "Nightfall" (dark seeds, no Light variant), "Dusk"
     * (dark seeds with a Light variant) and "Future" (a newer theme file version).
     */
    async pairWithPublishedThemes() {
      await post("reset");
      await post("pair");
      await post("publish");
    },
    /** `t3 theme set <id>` on the controlled T3 environment. */
    setDefaultTheme: (id: string) => post(`default?theme=${id}`),
    async pairingCode() {
      return ((await (await post("pairing-code")).json()) as { code: string }).code;
    },
    /**
     * The same fixture under `localhost` instead of `127.0.0.1`: another origin, so another
     * browser profile's storage, mode and client access.
     */
    otherAddress,
    /** Application settings of an approved browser profile at the other address, following Ocean. */
    async openApprovedClient(screen: Screen) {
      await app.open(otherAddress("/__fixture/remote-browser"));
      await app.open(otherAddress("/__fixture/approved-browser?next=/settings/application"));
      await expect(screen.getByText("Colors follow T3’s default theme “Ocean”.")).toBeVisible();
    },
    /**
     * The host follows the published "Nightfall", and an approved browser profile at the other
     * address shows its Application settings, so the host panel keeps its own mode.
     */
    async followNightfallInApprovedBrowser() {
      await post("reset");
      await post("pair");
      await post("publish");
      await post("default?theme=nightfall");
      await app.open(otherAddress("/__fixture/remote-browser"));
      await app.open(otherAddress("/__fixture/approved-browser?next=/settings/application"));
    },
  };
}

/**
 * An approved browser profile at another address that showed T3's Ocean theme in Dark, so
 * its storage holds the snapshot the server published.
 */
export async function clientWithCachedOcean({
  app,
  screen,
  browser,
}: {
  app: FixtureApp;
  screen: Screen;
  browser: Browser;
}) {
  const colors = themeColors(app);
  await colors.reset();
  await colors.pair();
  await colors.openApprovedClient(screen);
  await expect.poll(() => browser.evaluate(canvasColor)).toBe(oceanDark);
  await expect.poll(() => browser.evaluate(cachedSnapshot)).not.toBe(null);
  return { colors, application: colors.otherAddress("/settings/application") };
}

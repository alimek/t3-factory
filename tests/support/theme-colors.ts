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
  return {
    reset: () => post("reset"),
    pair: () => post("pair"),
    revoke: () => post("revoke"),
    async pairingCode() {
      return ((await (await post("pairing-code")).json()) as { code: string }).code;
    },
    /**
     * The same fixture under `localhost` instead of `127.0.0.1`: another origin, so another
     * browser profile's storage, mode and client access.
     */
    /** Application settings of an approved browser profile at the other address, following Ocean. */
    async openApprovedClient(screen: Screen) {
      await app.open(this.otherAddress("/__fixture/remote-browser"));
      await app.open(this.otherAddress("/__fixture/approved-browser?next=/settings/application"));
      await expect(screen.getByText("Colors follow T3’s default theme “Ocean”.")).toBeVisible();
    },
    otherAddress(path: string) {
      const url = new URL(path, app.baseUrl);
      url.hostname = "localhost";
      return url.href;
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

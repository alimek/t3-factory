type FixtureApp = { baseUrl: string | undefined; open(path: string): Promise<unknown> };

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

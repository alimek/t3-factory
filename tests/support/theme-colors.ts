type FixtureApp = { baseUrl: string | undefined };

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
    otherAddress(path: string) {
      const url = new URL(path, app.baseUrl);
      url.hostname = "localhost";
      return url.href;
    },
  };
}

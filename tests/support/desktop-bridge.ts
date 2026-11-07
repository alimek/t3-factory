// The bundled desktop UI asks the native shell for its role. This stand-in bridge reports
// a first launch and records the choice; native lifecycle is proven by the packaged probe.
export const desktopBridgeScript = (
  role: "client" | null = null,
  update: "available" | "downloaded" | "downloading" = "downloaded",
  releaseNotes:
    | string
    | null = "<ul><li>Reopen authorization from an approved client.</li><li>Review client and server upgrades together.</li></ul>",
) => `
  (() => {
    let state = {
      version: "0.1.0", role: ${JSON.stringify(role)}, server: ${JSON.stringify(role === "client" ? { url: "https://factory.example", fingerprint: "fixture" } : null)}, launchAtLogin: false, updateChannel: "stable",
      backend: { state: "stopped", message: null },
      update: { state: ${JSON.stringify(update)}, version: "0.2.0", progress: 64, downloadedBytes: 81000000, totalBytes: 126000000, message: null, releaseNotes: ${JSON.stringify(releaseNotes)} },
    };
    const listeners = new Set();
    const publish = () => listeners.forEach((listener) => listener(state));
    window.factoryDesktop = {
      getState: async () => state,
      onState: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      chooseRole: async (role) => { state = { ...state, role }; publish(); return { ok: true }; },
      probeServer: async () => ({ ok: false, message: "No Factory server answered securely at that address." }),
      connectServer: async () => ({ ok: true }),
      forgetServer: async () => ({ ok: true }),
      retryBackend: async () => ({ ok: true }),
      setLaunchAtLogin: async () => ({ ok: true }),
      checkForUpdates: async () => ({ ok: true }),
      downloadUpdate: async () => { state = { ...state, update: { ...state.update, state: "downloaded", progress: 100 } }; publish(); return { ok: true }; },
      setUpdateChannel: async (updateChannel) => { state = { ...state, updateChannel }; publish(); return { ok: true }; },
      installUpdate: async () => { window.__clientInstallRequested = true; state = { ...state, update: { ...state.update, state: "idle", version: null } }; publish(); return { ok: true }; },
    };
  })();
`;

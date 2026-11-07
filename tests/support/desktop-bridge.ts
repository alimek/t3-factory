// The bundled desktop UI asks the native shell for its role. This stand-in bridge reports
// a first launch and records the choice; native lifecycle is proven by the packaged probe.
export const desktopBridgeScript = (
  role: "client" | null = null,
  update: "available" | "downloaded" | "downloading" = "downloaded",
  confirmInstall = false,
  releaseNotes:
    | string
    | null = "<ul><li>Reopen authorization from an approved client.</li><li>Choose when to download and install updates.</li></ul>",
) => `
  (() => {
    let state = {
      version: "0.1.0", role: ${JSON.stringify(role)}, server: ${JSON.stringify(role === "client" ? { url: "https://factory.example", fingerprint: "fixture" } : null)}, launchAtLogin: false, updateChannel: "stable", autoDownloadUpdates: true,
      backend: { state: "stopped", message: null },
      update: { state: ${JSON.stringify(update)}, version: "0.2.0", progress: 42, message: null, releaseNotes: ${JSON.stringify(releaseNotes)} },
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
      setUpdatePreferences: async (change) => { state = { ...state, ...(change.channel ? { updateChannel: change.channel } : {}), ...("autoDownload" in change ? { autoDownloadUpdates: change.autoDownload } : {}) }; publish(); return { ok: true }; },
      installUpdate: async () => { if (${JSON.stringify(confirmInstall)} && !window.confirm("Install the downloaded update and restart Factory?")) return { ok: false, message: "Installation cancelled. The update is still ready." }; state = { ...state, update: { ...state.update, state: "idle", message: "Update installation requested." } }; publish(); return { ok: true }; },
    };
  })();
`;

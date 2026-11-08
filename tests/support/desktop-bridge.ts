// The bundled desktop UI asks the native shell for its role. This stand-in bridge reports
// a first launch and records the choice; native lifecycle is proven by the packaged probe.
// Its live relay stands in for the main process: a page WebSocket to the fixture, relayed
// over a MessageChannel with the same delivery messages the desktop main process posts.
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
      backend: { state: "stopped", message: null }, minimized: false,
      update: { state: ${JSON.stringify(update)}, version: "0.2.0", progress: 64, downloadedBytes: 81000000, totalBytes: 126000000, message: null, checkedAt: null, releaseNotes: ${JSON.stringify(releaseNotes)} },
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
      openLive: async (query, nonce) => {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(scheme + "://" + location.host + "/api/live" + query);
        socket.binaryType = "arraybuffer";
        const { port1, port2 } = new MessageChannel();
        let closed = false;
        const end = (code, reason) => {
          if (closed) return;
          closed = true;
          port1.postMessage({ type: "close", code, reason });
          port1.close();
        };
        socket.onopen = () => closed || port1.postMessage({ type: "open" });
        socket.onmessage = ({ data }) => closed || port1.postMessage({ type: "message", data: typeof data === "string" ? data : new Uint8Array(data) });
        socket.onclose = ({ code, reason }) => end(code === 1005 ? 1000 : code, reason);
        socket.onerror = () => end(1006, "");
        port1.onmessage = ({ data }) => {
          if (data.type === "message" && socket.readyState === WebSocket.OPEN) socket.send(data.data);
          if (data.type === "close") { closed = true; port1.close(); socket.close(); }
        };
        window.postMessage({ type: "factory:live-port", nonce }, location.origin, [port2]);
        return { ok: true };
      },
    };
  })();
`;

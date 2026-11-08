// Sandboxed preload: a fixed, typed request surface. No Node, IPC object or remote content
// access is passed to the page; the main process validates the sender for every call.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { channels } from "./ipc.ts";

contextBridge.exposeInMainWorld("factoryDesktop", {
  getState: () => ipcRenderer.invoke(channels.getState),
  onState(listener: (state: unknown) => void) {
    const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on(channels.state, handler);
    return () => {
      ipcRenderer.removeListener(channels.state, handler);
    };
  },
  chooseRole: (role: "server" | "client") => ipcRenderer.invoke(channels.chooseRole, role),
  probeServer: (address: string) => ipcRenderer.invoke(channels.probeServer, String(address)),
  connectServer: (url: string, fingerprint: string) =>
    ipcRenderer.invoke(channels.connectServer, String(url), String(fingerprint)),
  forgetServer: () => ipcRenderer.invoke(channels.forgetServer),
  retryBackend: () => ipcRenderer.invoke(channels.retryBackend),
  setLaunchAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke(channels.setLaunchAtLogin, enabled === true),
  checkForUpdates: () => ipcRenderer.invoke(channels.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(channels.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(channels.installUpdate),
  setUpdateChannel: (channel: string) =>
    ipcRenderer.invoke(channels.setUpdateChannel, String(channel)),
  /**
   * contextBridge cannot pass a MessagePort: the port arrives here and is forwarded to the
   * page as a same-origin window message `{ type: "factory:live-port", nonce }`.
   */
  async openLive(query: string, nonce: string) {
    const expected = String(nonce);
    const deliver = (event: IpcRendererEvent, received: unknown) => {
      if (received !== expected) return;
      ipcRenderer.removeListener(channels.livePort, deliver);
      window.postMessage({ type: channels.livePort, nonce: expected }, window.location.origin, [
        ...event.ports,
      ]);
    };
    ipcRenderer.on(channels.livePort, deliver);
    const result = (await ipcRenderer
      .invoke(channels.openLive, String(query), expected)
      .catch((error: unknown) => {
        ipcRenderer.removeListener(channels.livePort, deliver);
        throw error;
      })) as { ok: boolean };
    if (!result.ok) ipcRenderer.removeListener(channels.livePort, deliver);
    return result;
  },
});

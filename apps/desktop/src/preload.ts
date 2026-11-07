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
  setUpdatePreferences: (preferences: { channel?: string; autoDownload?: boolean }) =>
    ipcRenderer.invoke(channels.setUpdatePreferences, {
      ...(preferences.channel === undefined ? {} : { channel: String(preferences.channel) }),
      ...(preferences.autoDownload === undefined
        ? {}
        : { autoDownload: preferences.autoDownload === true }),
    }),
});

// Sandboxed preload: a fixed, typed request surface. No Node, IPC object or remote content
// access is passed to the page; the main process validates the sender for every call.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  livePortMessage,
  type DesktopMenuCommandId,
  type DesktopResult,
  type DesktopState,
  type FactoryDesktop,
} from "@t3-factory/contracts/desktop-bridge";
import { channels } from "./ipc.ts";

contextBridge.exposeInMainWorld("factoryDesktop", {
  getState: () => ipcRenderer.invoke(channels.getState),
  onState(listener) {
    const handler = (_event: IpcRendererEvent, state: DesktopState) => listener(state);
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
  setMenuBarIcon: (enabled: boolean) =>
    ipcRenderer.invoke(channels.setMenuBarIcon, enabled === true),
  checkForUpdates: () => ipcRenderer.invoke(channels.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(channels.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(channels.installUpdate),
  setUpdateChannel: (channel: string) =>
    ipcRenderer.invoke(channels.setUpdateChannel, String(channel)),
  setAppearance: (appearance: string) =>
    ipcRenderer.invoke(channels.setAppearance, String(appearance)),
  setMenuState: (state: unknown) => ipcRenderer.invoke(channels.setMenuState, state),
  onMenuCommand(listener) {
    // The main process sends only ids it built its menu from.
    const handler = (_event: IpcRendererEvent, id: unknown) =>
      listener(String(id) as DesktopMenuCommandId);
    ipcRenderer.on(channels.menuCommand, handler);
    return () => {
      ipcRenderer.removeListener(channels.menuCommand, handler);
    };
  },
  /**
   * contextBridge cannot pass a MessagePort: the port arrives here and is forwarded to the
   * page as a same-origin window message `{ type: livePortMessage, nonce }`.
   */
  async openLive(query: string, nonce: string) {
    const expected = String(nonce);
    const deliver = (event: IpcRendererEvent, received: unknown) => {
      if (received !== expected) return;
      ipcRenderer.removeListener(channels.livePort, deliver);
      window.postMessage({ type: livePortMessage, nonce: expected }, window.location.origin, [
        ...event.ports,
      ]);
    };
    ipcRenderer.on(channels.livePort, deliver);
    const result = (await ipcRenderer
      .invoke(channels.openLive, String(query), expected)
      .catch((error: unknown) => {
        ipcRenderer.removeListener(channels.livePort, deliver);
        throw error;
      })) as DesktopResult;
    if (!result.ok) ipcRenderer.removeListener(channels.livePort, deliver);
    return result;
  },
} satisfies FactoryDesktop);

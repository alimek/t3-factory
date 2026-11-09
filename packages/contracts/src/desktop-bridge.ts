/**
 * The desktop bridge: the narrow native surface the desktop preload exposes to bundled UI
 * only. The sandboxed preload bundles this module, so it imports types only and declares no
 * globals; the renderer declares the bridge on `window`.
 */
import type { ApplicationUpdate, UpdateChannel } from "./index.ts";

/** Same-origin window message type that carries the live relay port from preload to page. */
export const livePortMessage = "factory:live-port";

export type DesktopRole = "server" | "client";

export interface DesktopState {
  readonly version: string;
  readonly role: DesktopRole | null;
  /** Client role: the single remembered server and the certificate this client pinned. */
  readonly server: { readonly url: string; readonly fingerprint: string } | null;
  /** Server role: the supervised local backend. */
  readonly backend: {
    readonly state: "stopped" | "starting" | "running" | "failed";
    readonly message: string | null;
  };
  readonly launchAtLogin: boolean;
  /** The release track this installation updates from. */
  readonly updateChannel: UpdateChannel;
  readonly update: ApplicationUpdate;
  /**
   * The window is minimized. Electron keeps a minimized window's document "visible" on
   * macOS, so live delivery treats this like a hidden document.
   */
  readonly minimized: boolean;
}

export type DesktopResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface ServerProbe {
  readonly ok: true;
  readonly url: string;
  readonly fingerprint: string;
  /** The address carried a fingerprint that matched the presented certificate. */
  readonly matchesExpected: boolean;
  /** The system already trusts this certificate (for example a Tailscale certificate). */
  readonly systemTrusted: boolean;
}

/** One registry command as the native application menu shows it. */
export interface DesktopMenuCommand {
  readonly label: string;
  readonly binding: {
    readonly key: string;
    readonly mod: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
  } | null;
  readonly enabled: boolean;
}

export interface FactoryDesktop {
  getState(): Promise<DesktopState>;
  onState(listener: (state: DesktopState) => void): () => void;
  /** Switching away from a running server asks for native confirmation when Runs are open. */
  chooseRole(role: DesktopRole): Promise<DesktopResult>;
  probeServer(
    address: string,
  ): Promise<ServerProbe | { readonly ok: false; readonly message: string }>;
  connectServer(url: string, fingerprint: string): Promise<DesktopResult>;
  forgetServer(): Promise<DesktopResult>;
  retryBackend(): Promise<DesktopResult>;
  setLaunchAtLogin(enabled: boolean): Promise<DesktopResult>;
  checkForUpdates(): Promise<DesktopResult>;
  downloadUpdate(): Promise<DesktopResult>;
  /** Installs a downloaded update confirmed in the upgrade review; never on an unrelated Quit. */
  installUpdate(): Promise<DesktopResult>;
  /** A changed channel discards an update found on the previous one and checks again. */
  setUpdateChannel(channel: UpdateChannel): Promise<DesktopResult>;
  /**
   * Opens the window's live delivery socket in the main process (`query` carries only
   * `protocol` and `minimum`). The relay port arrives as a same-origin window message
   * `{ type: livePortMessage, nonce }`; use `desktopLiveSocket` rather than this directly.
   */
  openLive(query: string, nonce: string): Promise<DesktopResult>;
  /** Publishes registry commands for the application menu; `null` when no commands are mounted. */
  setMenuState(
    commands: Readonly<Record<string, DesktopMenuCommand>> | null,
  ): Promise<DesktopResult>;
  /** A menu item chosen with the pointer; menu accelerators never arrive here. */
  onMenuCommand(listener: (id: string) => void): () => void;
}

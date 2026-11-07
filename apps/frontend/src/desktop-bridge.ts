/**
 * The narrow native surface the desktop preload exposes to bundled UI only. Browsers and
 * remote content never have it; the UI checks for its presence instead of guessing.
 */
import type { ApplicationUpdate, UpdateChannel } from "@t3-factory/contracts";

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
}

declare global {
  interface Window {
    readonly factoryDesktop?: FactoryDesktop;
  }
}

export const desktopBridge = (): FactoryDesktop | undefined =>
  typeof window === "undefined" ? undefined : window.factoryDesktop;

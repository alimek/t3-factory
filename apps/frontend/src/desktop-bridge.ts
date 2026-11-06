/**
 * The narrow native surface the desktop preload exposes to bundled UI only. Browsers and
 * remote content never have it; the UI checks for its presence instead of guessing.
 */
export type DesktopRole = "server" | "client";
export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

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
  readonly update: {
    readonly state: UpdateState;
    readonly version: string | null;
    readonly progress: number | null;
    readonly releaseNotes: string | null;
    readonly message: string | null;
  };
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
  /** Installs a downloaded update after local confirmation; never runs on an unrelated Quit. */
  installUpdate(): Promise<DesktopResult>;
}

declare global {
  interface Window {
    readonly factoryDesktop?: FactoryDesktop;
  }
}

export const desktopBridge = (): FactoryDesktop | undefined =>
  typeof window === "undefined" ? undefined : window.factoryDesktop;

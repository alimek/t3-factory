import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How this client trusts its server: a pinned Factory authority, or the system's trust store. */
export type ServerTrust =
  | { readonly mode: "pinned"; readonly anchor: string; readonly fingerprint: string }
  | { readonly mode: "system"; readonly fingerprint: string };

export interface RememberedServer {
  readonly url: string;
  readonly trust: ServerTrust;
  /** Keychain-encrypted (safeStorage) client credential; never handed to the renderer. */
  readonly credential: string | null;
}

/**
 * Per-installation desktop settings, kept outside the Factory database because a client
 * installation has none. Versioned like stored JSON: readers accept only known versions.
 */
export interface DesktopSettings {
  readonly version: 1;
  readonly role: "server" | "client" | null;
  readonly server: RememberedServer | null;
  /** Off by default; set only by an explicit user choice. */
  readonly launchAtLogin: boolean;
}

const initialSettings: DesktopSettings = {
  version: 1,
  role: null,
  server: null,
  launchAtLogin: false,
};

function isTrust(value: unknown): value is ServerTrust {
  if (typeof value !== "object" || value === null) return false;
  const trust = value as Record<string, unknown>;
  if (typeof trust.fingerprint !== "string") return false;
  return trust.mode === "system" || (trust.mode === "pinned" && typeof trust.anchor === "string");
}

function isServer(value: unknown): value is RememberedServer {
  if (typeof value !== "object" || value === null) return false;
  const server = value as Record<string, unknown>;
  return (
    typeof server.url === "string" &&
    isTrust(server.trust) &&
    (server.credential === null || typeof server.credential === "string")
  );
}

/** Version 1 is the only stored shape; anything else is reported, never silently reused. */
function parseSettings(raw: unknown): DesktopSettings | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return undefined;
  const role = value.role === "server" || value.role === "client" ? value.role : null;
  const server = value.server === null || value.server === undefined ? null : value.server;
  if (server !== null && !isServer(server)) return undefined;
  return { version: 1, role, server, launchAtLogin: value.launchAtLogin === true };
}

export class SettingsStore {
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly path: string,
    private current: DesktopSettings,
    readonly problem: string | null,
  ) {}

  /** An unreadable or unknown file is preserved beside a fresh one instead of overwritten. */
  static async open(directory: string): Promise<SettingsStore> {
    const path = join(directory, "desktop-settings.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return new SettingsStore(path, initialSettings, null);
    }
    let parsed: DesktopSettings | undefined;
    try {
      parsed = parseSettings(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed) return new SettingsStore(path, parsed, null);
    const kept = `${path}.unreadable-${Date.now()}`;
    await rename(path, kept);
    return new SettingsStore(
      path,
      initialSettings,
      `Desktop settings could not be read and were kept at ${kept}. Choose this computer's role again.`,
    );
  }

  get(): DesktopSettings {
    return this.current;
  }

  update(
    change:
      | Partial<Omit<DesktopSettings, "version">>
      | ((current: DesktopSettings) => Partial<Omit<DesktopSettings, "version">> | null),
  ): Promise<DesktopSettings> {
    // Derive and write each snapshot in order, including unrelated shell preferences.
    const write = this.writes.then(async () => {
      const patch = typeof change === "function" ? change(this.current) : change;
      if (patch === null) return this.current;
      const next: DesktopSettings = { ...this.current, ...patch, version: 1 };
      await writeFile(`${this.path}.next`, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(`${this.path}.next`, this.path);
      this.current = next;
      return next;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import electronUpdater, { type VerifyUpdateSupport } from "electron-updater";
import type { ApplicationUpdate, UpdateChannel } from "@t3-factory/contracts";

export interface UpdatePreferences {
  readonly channel: UpdateChannel;
  readonly autoDownload: boolean;
}

const checkEveryMs = 6 * 3600_000;

/** The track an installation follows until its user chooses one: the track of its own build. */
export const buildChannel = (): UpdateChannel =>
  app.getVersion().includes("-beta.") ? "beta" : "stable";

/**
 * Notes of every version between the installed one and the update, newest first. Stable skips
 * beta builds: the Release notes already cover their changes.
 */
function changelog(
  notes: Parameters<VerifyUpdateSupport>[0]["releaseNotes"],
  channel: UpdateChannel,
): string | null {
  if (!Array.isArray(notes)) return typeof notes === "string" ? notes : null;
  const entries = notes
    .filter((entry) => entry.note?.trim() && (channel === "beta" || !entry.version.includes("-")))
    .map((entry) => `<h3>${entry.version}</h3>${entry.note}`);
  return entries.length ? entries.join("") : null;
}

/**
 * GitHub Releases (or the configured feed) through electron-updater: automatic checks,
 * downloads that are automatic only when preferred, installation only through `install()`.
 * A Quit never installs an update.
 */
export class Updates {
  private status: ApplicationUpdate = {
    state: "idle",
    version: null,
    progress: null,
    releaseNotes: null,
    message: null,
  };
  private readonly updater = electronUpdater.autoUpdater;
  private preferences: UpdatePreferences | null = null;

  constructor(private readonly changed: (status: ApplicationUpdate) => void) {}

  get current(): ApplicationUpdate {
    return this.status;
  }

  private set(change: Partial<ApplicationUpdate>) {
    this.status = { ...this.status, ...change };
    this.changed(this.status);
  }

  /** Development runs and builds without a configured feed report updates as unsupported. */
  start(preferences: UpdatePreferences) {
    if (app.getVersion().includes("+dev.")) {
      this.set({
        state: "unsupported",
        message: "Local development build. Install another local package to update it.",
      });
      return;
    }
    if (!app.isPackaged || !existsSync(join(process.resourcesPath, "app-update.yml"))) {
      this.set({
        state: "unsupported",
        message: "This build has no release feed; install a released package to receive updates.",
      });
      return;
    }
    this.updater.autoInstallOnAppQuit = false;
    this.updater.fullChangelog = true;
    this.apply(preferences);
    this.updater.on("checking-for-update", () => this.set({ state: "checking", message: null }));
    this.updater.on("update-not-available", () =>
      this.set({ state: "idle", version: null, progress: null, releaseNotes: null }),
    );
    this.updater.on("update-available", (info) =>
      this.set({
        state: this.updater.autoDownload ? "downloading" : "available",
        version: info.version,
        progress: 0,
        releaseNotes: changelog(info.releaseNotes, this.preferences?.channel ?? "stable"),
      }),
    );
    this.updater.on("download-progress", (progress) =>
      this.set({ state: "downloading", progress: progress.percent }),
    );
    this.updater.on("update-downloaded", (info) =>
      this.set({ state: "downloaded", version: info.version, progress: 100 }),
    );
    this.updater.on("error", (error) =>
      this.set({
        state: "error",
        progress: null,
        message: `${error.message.split("\n")[0]} Your data and role are unchanged.`,
      }),
    );
    void this.check();
    setInterval(() => void this.check(), checkEveryMs).unref();
  }

  /**
   * Beta follows prereleases and stable Releases, whichever is newer; stable follows only
   * Releases. Leaving beta never downgrades: the installed beta stays until a newer Release.
   */
  private apply(preferences: UpdatePreferences) {
    this.preferences = preferences;
    this.updater.channel = preferences.channel === "beta" ? "beta" : "latest";
    this.updater.allowPrerelease = preferences.channel === "beta";
    this.updater.allowDowngrade = false;
    this.updater.autoDownload = preferences.autoDownload;
  }

  /** A changed track discards an update found on the previous one and checks again. */
  configure(preferences: UpdatePreferences): string | null {
    if (this.status.state === "unsupported" || this.preferences === null) {
      this.preferences = preferences;
      return null;
    }
    const switched = preferences.channel !== this.preferences.channel;
    if (switched && this.status.state === "downloading")
      return "Wait for the current download to finish before changing the update channel.";
    this.apply(preferences);
    if (switched) {
      this.set({ state: "idle", version: null, progress: null, releaseNotes: null, message: null });
      void this.check();
    } else if (preferences.autoDownload) void this.download();
    return null;
  }

  async check(): Promise<void> {
    if (["unsupported", "downloaded", "downloading", "checking"].includes(this.status.state))
      return;
    await this.updater.checkForUpdates().catch(() => undefined);
  }

  /** Without automatic downloads, a download starts only after an explicit action. */
  async download(): Promise<void> {
    if (this.status.state !== "available") return;
    this.set({ state: "downloading", progress: 0, message: null });
    await this.updater.downloadUpdate().catch(() => undefined);
  }

  /** Called only after a confirmation and after the backend shut down in order. */
  install() {
    try {
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      this.set({
        state: "error",
        progress: null,
        message: `Installation failed: ${String(error)} Your data and role are unchanged.`,
      });
    }
  }
}

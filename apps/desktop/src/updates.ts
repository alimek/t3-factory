import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import electronUpdater, { type VerifyUpdateSupport } from "electron-updater";
import type { ApplicationUpdate, UpdateChannel } from "@t3-factory/contracts";

const checkEveryMs = 3600_000;

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
    .filter((entry) => channel === "beta" || !entry.version.includes("-"))
    .map(
      (entry) => `<h3>${entry.version}</h3><div>${entry.note?.trim() || "No release notes."}</div>`,
    );
  return entries.length ? entries.join("") : null;
}

/**
 * GitHub Releases (or the configured feed) through electron-updater: automatic checks,
 * explicit downloads, installation only through `install()`. A Quit never installs an update.
 */
export class Updates {
  private status: ApplicationUpdate = {
    state: "idle",
    version: null,
    progress: null,
    downloadedBytes: null,
    totalBytes: null,
    releaseNotes: null,
    message: null,
    checkedAt: null,
  };
  private readonly updater = electronUpdater.autoUpdater;
  private channel: UpdateChannel | null = null;

  constructor(private readonly changed: (status: ApplicationUpdate) => void) {}

  get current(): ApplicationUpdate {
    return this.status;
  }

  private set(change: Partial<ApplicationUpdate>) {
    this.status = { ...this.status, ...change };
    this.changed(this.status);
  }

  /** Development runs and builds without a configured feed report updates as unsupported. */
  start(channel: UpdateChannel) {
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
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.fullChangelog = true;
    this.apply(channel);
    this.updater.on("checking-for-update", () => this.set({ state: "checking", message: null }));
    this.updater.on("update-not-available", () =>
      this.set({
        state: "idle",
        version: null,
        progress: null,
        releaseNotes: null,
        checkedAt: new Date().toISOString(),
      }),
    );
    this.updater.on("update-available", (info) =>
      this.set({
        state: "available",
        checkedAt: new Date().toISOString(),
        version: info.version,
        progress: 0,
        releaseNotes: changelog(info.releaseNotes, this.channel ?? "stable"),
      }),
    );
    this.updater.on("download-progress", (progress) =>
      this.set({
        state: "downloading",
        progress: progress.percent,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
      }),
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
  private apply(channel: UpdateChannel) {
    this.channel = channel;
    this.updater.channel = channel === "beta" ? "beta" : "latest";
    this.updater.allowPrerelease = channel === "beta";
    this.updater.allowDowngrade = false;
  }

  /** A changed track discards an update found on the previous one and checks again. */
  configure(channel: UpdateChannel): string | null {
    if (this.status.state === "unsupported" || this.channel === null || channel === this.channel)
      return null;
    if (this.status.state === "checking" || this.status.state === "downloading")
      return "Wait for the current update check or download to finish before changing the channel.";
    this.apply(channel);
    this.set({ state: "idle", version: null, progress: null, releaseNotes: null, message: null });
    void this.check();
    return null;
  }

  async check(): Promise<void> {
    if (["unsupported", "downloaded", "downloading", "checking"].includes(this.status.state))
      return;
    await this.updater.checkForUpdates().catch(() => undefined);
  }

  /** A download starts only after an explicit action, never while checking metadata. */
  async download(): Promise<void> {
    if (this.status.state !== "available") return;
    this.set({ state: "downloading", progress: 0, downloadedBytes: 0, message: null });
    await this.updater.downloadUpdate().catch(() => undefined);
  }

  /** An installation that could not start leaves the app running on its current release. */
  fail(message: string) {
    this.set({ state: "error", progress: null, message });
  }

  /** Called only after the upgrade review was confirmed and the backend shut down in order. */
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

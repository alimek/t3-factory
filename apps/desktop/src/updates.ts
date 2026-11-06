import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import electronUpdater from "electron-updater";

export interface UpdateStatus {
  readonly state:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "error"
    | "unsupported";
  readonly version: string | null;
  readonly progress: number | null;
  readonly releaseNotes: string | null;
  readonly message: string | null;
}

const checkEveryMs = 6 * 3600_000;

/**
 * GitHub Releases (or the configured feed) through electron-updater: automatic checks and
 * explicit downloads, installation only through `install()`. A Quit never installs an update.
 */
export class Updates {
  private status: UpdateStatus = {
    state: "idle",
    version: null,
    progress: null,
    releaseNotes: null,
    message: null,
  };
  private readonly updater = electronUpdater.autoUpdater;

  constructor(private readonly changed: (status: UpdateStatus) => void) {}

  get current(): UpdateStatus {
    return this.status;
  }

  private set(change: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...change };
    this.changed(this.status);
  }

  /** Development runs and builds without a configured feed report updates as unsupported. */
  start() {
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
    this.updater.allowPrerelease = false;
    this.updater.on("checking-for-update", () => this.set({ state: "checking", message: null }));
    this.updater.on("update-not-available", () =>
      this.set({ state: "idle", version: null, progress: null, releaseNotes: null }),
    );
    this.updater.on("update-available", (info) =>
      this.set({
        state: "available",
        version: info.version,
        progress: 0,
        releaseNotes:
          typeof info.releaseNotes === "string"
            ? info.releaseNotes
            : (info.releaseNotes
                ?.filter((note) => note.note?.trim())
                .map((note) => `${note.version}\n${note.note}`)
                .join("\n\n") ?? null),
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

  async check(): Promise<void> {
    if (["unsupported", "downloaded", "downloading", "checking"].includes(this.status.state))
      return;
    await this.updater.checkForUpdates().catch(() => undefined);
  }

  /** Download starts only after an explicit local action, never while checking metadata. */
  async download(): Promise<void> {
    if (this.status.state !== "available") return;
    this.set({ state: "downloading", progress: 0, message: null });
    await this.updater.downloadUpdate().catch(() => undefined);
  }

  /** Called only after the local user confirmed and the backend shut down in order. */
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

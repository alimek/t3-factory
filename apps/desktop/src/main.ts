/**
 * Electron shell: one installation role, the bundled UI on `factory://app`, a supervised
 * local backend (server role) or one pinned remote server (client role). Business rules
 * stay in the backend's public operations.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import type {
  Result as OperationResult,
  ServerUpdateAction,
  UpdateChannel,
} from "@t3-factory/contracts";
import { ApprovedClient } from "./approved-client.ts";
import { BackendSupervisor } from "./backend.ts";
import { channels } from "./ipc.ts";
import { buildApplicationMenu, parseMenuState, withoutOpenRun, type MenuState } from "./menu.ts";
import { hostLiveSocket, livePath, refuseLive, relayLive, type LivePort } from "./live-relay.ts";
import { appOrigin, factoryProtocolHandler, type ApiTarget } from "./protocol.ts";
import { SettingsStore } from "./settings-store.ts";
import { buildChannel, Updates } from "./updates.ts";

// Disposable profiles for probes and side-by-side installs; FACTORY_HOME selects server data.
if (process.env.FACTORY_DESKTOP_USER_DATA)
  app.setPath("userData", process.env.FACTORY_DESKTOP_USER_DATA);

// Factory's UI is dark-only. Keep native window chrome and dialogs consistent even
// when macOS uses its light appearance; CSS color-scheme cannot style the title bar.
nativeTheme.themeSource = "dark";

protocol.registerSchemesAsPrivileged([
  { scheme: "factory", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const here = dirname(fileURLToPath(import.meta.url));
const uiDirectory = join(here, "ui");
const uiPartition = "persist:factory-ui";
const documentationUrl = "https://github.com/alimek/t3-factory/tree/main/docs#readme";

type Result = { readonly ok: true } | { readonly ok: false; readonly message: string };
const failed = (message: string): Result => ({ ok: false, message });

let store: SettingsStore;
let approvedClient: ApprovedClient;
let backend: BackendSupervisor;
let updates: Updates;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let menuState: MenuState = {};
/** Set only after the local user confirmed and the backend stopped in order. */
let quitting = false;
/** Quit waits for the window to unload, so a kept Studio draft still has its services. */
let quitAfterWindowCloses = false;
let installingUpdate = false;
/** An approved client's install request was accepted and starts on the next tick. */
let serverInstallAccepted = false;

const updateChannel = (): UpdateChannel => store.get().updateChannel ?? buildChannel();

function desktopState() {
  const settings = store.get();
  return {
    version: app.getVersion(),
    role: settings.role,
    server: settings.server
      ? { url: settings.server.url, fingerprint: settings.server.trust.fingerprint }
      : null,
    backend: backend.state,
    launchAtLogin: settings.launchAtLogin,
    updateChannel: updateChannel(),
    update: updates.current,
    // macOS keeps a minimized window's document "visible"; live delivery detaches on this.
    minimized: window !== null && !window.isDestroyed() && window.isMinimized(),
  };
}

function broadcast() {
  // Quit and role changes can race the window's destruction.
  if (window && !window.isDestroyed()) window.webContents.send(channels.state, desktopState());
  refreshTray();
}

function apiTarget(): ApiTarget {
  const settings = store.get();
  if (settings.role === "server")
    return backend.port === null
      ? null
      : { kind: "host", base: `http://127.0.0.1:${backend.port}` };
  const connection = approvedClient.capture();
  return connection ? { kind: "remote", connection } : null;
}

async function openRunCount(): Promise<number | null> {
  if (backend.port === null) return 0;
  try {
    const response = await fetch(`http://127.0.0.1:${backend.port}/api/host/lifecycle`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json()) as { ok: boolean; value?: { openRunCount: number } };
    return body.ok && body.value ? body.value.openRunCount : null;
  } catch {
    return null;
  }
}

const interruption = {
  quit: { button: "Quit Factory", verb: "Quitting" },
  switch: { button: "Stop server and switch", verb: "Switching to client mode" },
} as const;

/**
 * Host-local confirmation before Factory control stops. Quit and role switch never Stop
 * Runs; T3 work may continue while Factory is closed. Update installation is confirmed in
 * the upgrade review, which shows the same open-Run warning.
 */
async function confirmInterruption(action: keyof typeof interruption): Promise<boolean> {
  if (store.get().role !== "server" || backend.state.state !== "running") return true;
  const open = await openRunCount();
  if (action === "quit" && open === 0) return true;
  const runs =
    open === null
      ? "Factory could not count open Runs."
      : `${open} Run${open === 1 ? " is" : "s are"} still open.`;
  const { verb, button } = interruption[action];
  const options = {
    type: "warning" as const,
    buttons: [button, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `${verb} stops Factory control on this computer.`,
    detail: `${runs} Reports, Human answers and transitions wait until Factory runs again, and work already started in T3 may continue meanwhile. Runs are not stopped: on restart Factory reconciles them before eligible work resumes.`,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

async function stopBackendFor(action: keyof typeof interruption): Promise<boolean> {
  if (!(await confirmInterruption(action))) return false;
  await backend.stop();
  return true;
}

function openWindow() {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  const created = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "T3 Factory",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: "#09090b",
    // Windows and Linux show the application menu bar on Alt; macOS ignores this option.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      partition: uiPartition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${appOrigin}/`)) event.preventDefault();
  });
  // Electron silently cancels Reload and Close when a dirty Studio draft blocks unload;
  // ask instead, and the decision must be synchronous to take effect.
  created.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(created, {
      type: "warning",
      buttons: ["Keep editing", "Discard changes"],
      defaultId: 0,
      cancelId: 0,
      message: "Discard unsaved changes?",
      detail: "Studio has unsaved changes. Keep editing to save them, or discard them to continue.",
    });
    if (choice === 1) event.preventDefault();
    else quitAfterWindowCloses = false;
  });
  created.once("ready-to-show", () => created.show());
  created.on("minimize", broadcast);
  created.on("restore", broadcast);
  // Closing the window never stops the backend; the tray and Dock reopen it.
  created.on("closed", () => {
    window = null;
    applyMenuState(withoutOpenRun(menuState));
    if (quitAfterWindowCloses) app.quit();
  });
  window = created;
  void created.loadURL(`${appOrigin}/`);
}

function trayImage() {
  const image = nativeImage.createFromPath(join(here, "resources", "trayTemplate.png"));
  image.setTemplateImage(true);
  return image;
}

function refreshTray() {
  if (!tray) return;
  const settings = store.get();
  const status =
    settings.role === "server"
      ? `Server: ${backend.state.state}`
      : settings.role === "client"
        ? `Client of ${settings.server?.url ?? "no server"}`
        : "Role not chosen";
  tray.setToolTip(`T3 Factory — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: "Open Factory", click: openWindow },
      { label: "Quit Factory", click: () => app.quit() },
    ]),
  );
}

function applyMenuState(state: MenuState) {
  menuState = state;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenu(
        menuState,
        { platform: process.platform, development: !app.isPackaged },
        {
          run: (id) => {
            // Without a window the command has no renderer; reopening it is the useful answer.
            const target = window;
            openWindow();
            target?.webContents.send(channels.menuCommand, id);
          },
          checkForUpdates: () => void updates.check(),
          openDocumentation: () => void shell.openExternal(documentationUrl),
        },
      ),
    ),
  );
}

async function chooseRole(role: "server" | "client"): Promise<Result> {
  const current = store.get().role;
  if (role === current) return { ok: true };
  if (current === "server" && !(await stopBackendFor("switch")))
    return failed("Factory kept running as a server.");
  // Local data stays where it is; nothing is copied to or from another server.
  await approvedClient.chooseRole(role);
  if (role === "server") backend.start();
  broadcast();
  return { ok: true };
}

async function connectServer(url: string, fingerprint: string): Promise<Result> {
  try {
    await approvedClient.connect(url, fingerprint);
  } catch (error) {
    return failed(String(error));
  }
  broadcast();
  return { ok: true };
}

async function setLaunchAtLogin(enabled: boolean): Promise<Result> {
  app.setLoginItemSettings({ openAtLogin: enabled });
  await store.update({ launchAtLogin: enabled });
  broadcast();
  const status = app.getLoginItemSettings().status;
  if (enabled && status === "requires-approval")
    return failed("Approve T3 Factory in System Settings → General → Login Items.");
  return { ok: true };
}

async function setUpdateChannel(channel: unknown): Promise<Result> {
  if (channel !== "stable" && channel !== "beta") return failed("Choose stable or beta.");
  const problem = updates.configure(channel);
  if (problem) return failed(problem);
  await store.update({ updateChannel: channel });
  broadcast();
  return { ok: true };
}

/** Confirmed in the upgrade review; the backend still shuts down in order before replacement. */
async function installUpdate(): Promise<Result> {
  if (installingUpdate) return failed("Update installation is already in progress.");
  if (updates.current.state !== "downloaded") return failed("No downloaded update is ready.");
  installingUpdate = true;
  try {
    await backend.stop();
    if (updates.current.state !== "downloaded")
      throw new Error("The update is no longer ready. Check for updates again.");
    quitting = true;
    updates.install();
    return { ok: true };
  } catch (error) {
    installingUpdate = false;
    quitting = false;
    if (store.get().role === "server") backend.start();
    return failed(`Update installation could not start: ${String(error)}`);
  }
}

/** Server role: approved clients operate this installation's updater through the backend. */
async function runServerUpdate(action: ServerUpdateAction): Promise<OperationResult<null>> {
  const refused = (message: string): OperationResult<null> => ({
    ok: false,
    error: { code: "conflict", message, issues: [] },
  });
  const state = updates.current.state;
  if (action === "check") {
    await updates.check();
    return { ok: true, value: null };
  }
  if (action === "download") {
    if (state !== "available") return refused("No server update is available to download.");
    void updates.download();
    return { ok: true, value: null };
  }
  if (state !== "downloaded") return refused("No downloaded server update is ready to install.");
  if (installingUpdate || serverInstallAccepted)
    return refused("The server update is already being installed.");
  // Accepted before the deferred start, so a concurrent request is refused, not failed.
  serverInstallAccepted = true;
  // Answer the client before the backend begins its orderly shutdown.
  // A failed start is published as the updater's error, which the waiting client reads.
  setImmediate(
    () =>
      void installUpdate().then((result) => {
        serverInstallAccepted = false;
        if (!result.ok) updates.fail(result.message);
      }),
  );
  return { ok: true, value: null };
}

const liveChannels = new Set<{ close(reason: string): void }>();

function closeLive(reason: string) {
  for (const channel of liveChannels) channel.close(reason);
}

/** Captures the current target: a later selection or backend change closes this channel. */
function openLive(query: string, port: LivePort) {
  const target = apiTarget();
  if (!target) return refuseLive(port, "The Factory server is unreachable.");
  const path = livePath(query);
  const socket =
    target.kind === "host" ? hostLiveSocket(target.base, path) : target.connection.openSocket(path);
  const channel = relayLive(socket, port, () => liveChannels.delete(channel));
  liveChannels.add(channel);
}

/** Only the bundled UI in this app's own window may use the native bridge. */
function trustedFrame(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame?.url.startsWith(`${appOrigin}/`)) throw new Error("Untrusted sender.");
  return frame;
}

function handle<A extends unknown[]>(channel: string, run: (...args: A) => unknown) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    trustedFrame(event);
    return run(...(args as A));
  });
}

function registerBridge() {
  handle(channels.getState, () => desktopState());
  handle(channels.chooseRole, (role: unknown) =>
    role === "server" || role === "client" ? chooseRole(role) : failed("Unknown role."),
  );
  handle(channels.probeServer, async (address: string) => {
    try {
      const { url, fingerprint, matchesExpected, systemTrusted } =
        await approvedClient.probe(address);
      return { ok: true, url, fingerprint, matchesExpected, systemTrusted };
    } catch (error) {
      return failed(
        error instanceof Error && error.message.startsWith("Enter")
          ? error.message
          : "No Factory server answered securely at that address. Check that the server app is running with remote access enabled.",
      );
    }
  });
  handle(channels.connectServer, (url: string, fingerprint: string) =>
    connectServer(url, fingerprint),
  );
  handle(channels.forgetServer, async () => {
    await approvedClient.forget();
    broadcast();
    return { ok: true };
  });
  handle(channels.retryBackend, () => {
    if (store.get().role === "server") backend.start();
    return { ok: true };
  });
  handle(channels.setLaunchAtLogin, (enabled: boolean) => setLaunchAtLogin(enabled === true));
  handle(channels.checkForUpdates, async () => {
    await updates.check();
    return { ok: true };
  });
  handle(channels.downloadUpdate, async () => {
    if (updates.current.state !== "available") return failed("No update is available to download.");
    await updates.download();
    return { ok: true };
  });
  handle(channels.installUpdate, () => installUpdate());
  handle(channels.setUpdateChannel, (channel: unknown) => setUpdateChannel(channel));
  handle(channels.setMenuState, (commands: unknown) => {
    applyMenuState(parseMenuState(commands));
    return { ok: true };
  });
  // A MessagePort cannot be an invoke result; it goes to the requesting frame, keyed by nonce.
  ipcMain.handle(channels.openLive, (event, query: unknown, nonce: unknown) => {
    const frame = trustedFrame(event);
    if (typeof query !== "string" || typeof nonce !== "string")
      return failed("Invalid live request.");
    const { port1, port2 } = new MessageChannelMain();
    frame.postMessage(channels.livePort, nonce, [port2]);
    openLive(query, port1);
    return { ok: true };
  });
}

function registerUi() {
  const ui = session.fromPartition(uiPartition);
  ui.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ui.setPermissionCheckHandler(() => false);
  ui.protocol.handle("factory", factoryProtocolHandler({ uiDirectory, target: apiTarget }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", openWindow);
  app.on("activate", openWindow);
  // Background operation: the last window closing leaves the server and app running.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (window) {
      quitAfterWindowCloses = true;
      window.close();
      return;
    }
    quitAfterWindowCloses = false;
    const finish = () => {
      approvedClient.close();
      quitting = true;
      app.quit();
    };
    // Cancel keeps Factory running; a failed orderly stop still exits, which releases the
    // OS lock with the process, rather than leaving a half-quit application.
    void stopBackendFor("quit").then((stopped) => stopped && finish(), finish);
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      // A startup failure must be visible; the app never lingers without a window.
      dialog.showErrorBox(
        "T3 Factory could not start",
        `Factory could not read its desktop settings or start its window. Your Factory data was not changed.\n\n${String(error)}`,
      );
      app.exit(1);
    });
}

async function start() {
  store = await SettingsStore.open(app.getPath("userData"));
  approvedClient = await ApprovedClient.open(store, safeStorage);
  backend = new BackendSupervisor(
    join(here, "backend-host.js"),
    {
      FACTORY_UI_DIRECTORY: uiDirectory,
      FACTORY_APPLICATION_VERSION: app.getVersion(),
    },
    (state) => {
      if (state.state !== "running") closeLive("The Factory server stopped.");
      broadcast();
    },
    {
      status: () => ({
        channel: updates.current.state === "unsupported" ? null : updateChannel(),
        update: updates.current,
      }),
      run: runServerUpdate,
    },
  );
  updates = new Updates((status) => {
    if (installingUpdate && quitting && status.state === "error") {
      installingUpdate = false;
      quitting = false;
      // The updater failed before replacement: reopen the same home and reconcile.
      if (store.get().role === "server") backend.start();
      openWindow();
    }
    backend.publishUpdate();
    broadcast();
  });
  // A system termination request (kill, launchd) is not an interactive Quit: no dialog,
  // but the same orderly backend shutdown. Electron would otherwise only close windows.
  process.once("SIGTERM", () => {
    void backend
      .stop()
      .catch(() => undefined)
      .finally(() => {
        approvedClient.close();
        quitting = true;
        app.quit();
      });
  });
  registerUi();
  registerBridge();
  applyMenuState({});
  if (store.get().role === "server") backend.start();
  updates.start(updateChannel());
  tray = new Tray(trayImage());
  refreshTray();
  const settings = store.get();
  // Launch at login starts in the background with the remembered role.
  const background = settings.role !== null && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!background) openWindow();
  if (store.problem) void dialog.showMessageBox({ type: "warning", message: store.problem });
}

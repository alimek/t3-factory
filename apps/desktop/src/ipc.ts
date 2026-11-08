/** IPC channels between the preload bridge and the main process; nothing else is exposed. */
export const channels = {
  getState: "factory:get-state",
  state: "factory:state",
  chooseRole: "factory:choose-role",
  probeServer: "factory:probe-server",
  connectServer: "factory:connect-server",
  forgetServer: "factory:forget-server",
  retryBackend: "factory:retry-backend",
  setLaunchAtLogin: "factory:set-launch-at-login",
  checkForUpdates: "factory:check-for-updates",
  downloadUpdate: "factory:download-update",
  installUpdate: "factory:install-update",
  setUpdateChannel: "factory:set-update-channel",
  openLive: "factory:open-live",
  /** Main → preload: the live port; the preload forwards it to the page by window message. */
  livePort: "factory:live-port",
  /** Renderer → main: registry labels, bindings and availability for the application menu. */
  setMenuState: "factory:set-menu-state",
  /** Main → renderer: a menu item chosen with the pointer; the renderer executes it. */
  menuCommand: "factory:menu-command",
} as const;

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
} as const;

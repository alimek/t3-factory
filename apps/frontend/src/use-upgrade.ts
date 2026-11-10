import { useCallback, useEffect, useState } from "react";
import type { ApplicationUpdate, ServerUpdate, UpdateChannel } from "@t3-factory/contracts";
import { api } from "./api.ts";
import { useClientScope } from "./client-scope.ts";
import type { DesktopState } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "./desktop-bridge.ts";
import { OfflineError } from "./transport.ts";
import { useDesktopState } from "./desktop-state.ts";
import { usePolling } from "./use-polling.ts";

/** One installation the upgrade replaces: this desktop app, the server, or both. */
export interface UpgradeTarget {
  readonly kind: "client" | "server";
  /** Runs on this computer; a remote server is shared with other clients. */
  readonly local: boolean;
  readonly host: string | null;
  readonly current: string;
  readonly channel: UpdateChannel | null;
  readonly update: ApplicationUpdate;
}

export type UpgradePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "upgrading"
  | "error";

export interface UpgradeFailure {
  readonly title: string;
  readonly message: string;
}

const upToDateMs = 4000;
const serverRestartMs = 10 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Factory could not complete the update.";

/** The most urgent state across targets decides the single control the user sees. */
function phaseOf(
  targets: readonly UpgradeTarget[],
  upgrading: boolean,
  failure: UpgradeFailure | null,
  justChecked: boolean,
): UpgradePhase {
  const any = (state: ApplicationUpdate["state"]) => targets.some((t) => t.update.state === state);
  if (upgrading) return "upgrading";
  if (failure || any("error")) return "error";
  if (any("downloading")) return "downloading";
  if (any("available")) return "available";
  if (any("downloaded")) return "ready";
  if (any("checking")) return "checking";
  return justChecked ? "up-to-date" : "idle";
}

/** A server answers the handshake with its release; the target release means it restarted. */
async function waitForServer(version: string | null) {
  const deadline = Date.now() + serverRestartMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const protocol = await api.getProtocol().catch(() => null);
    if (protocol?.application === version) return;
    const status = protocol && (await api.getServerUpdate().catch(() => null));
    if (status?.update.state === "error")
      throw new Error(status.update.message ?? "The server could not install the update.");
  }
  throw new Error("The server did not come back on the new version within 10 minutes.");
}

/** This desktop app (the server itself in the server role), operated over the native bridge. */
function appTarget(state: DesktopState | null): UpgradeTarget | null {
  if (!desktopBridge() || !state || state.update.state === "unsupported") return null;
  return {
    kind: state.role === "server" ? "server" : "client",
    local: true,
    host: null,
    current: state.version,
    channel: state.updateChannel,
    update: state.update,
  };
}

/** The server this UI talks to, operated over its update API. */
function apiTarget(
  server: ServerUpdate | null,
  state: DesktopState | null,
  scope: "host" | "remote",
): UpgradeTarget | null {
  if (!server || server.update.state === "unsupported") return null;
  return {
    kind: "server",
    local: scope === "host",
    host: state?.server ? new URL(state.server.url).host : window.location.host,
    current: server.application,
    channel: server.channel,
    update: server.update,
  };
}

/** What confirming replaces: the downloaded targets, e.g. "client + server". */
export function upgradeScope(targets: readonly UpgradeTarget[]) {
  const kinds = new Set(
    targets.filter((target) => target.update.state === "downloaded").map((target) => target.kind),
  );
  return kinds.size === 2 ? "client + server" : kinds.has("client") ? "client" : "server";
}

function useServerUpdate(enabled: boolean, fast: boolean) {
  const [server, setServer] = useState<ServerUpdate | null>(null);
  const poll = useCallback(
    async (isActive: () => boolean) => {
      if (!enabled) return;
      // An older server has no update route; it is then simply not an upgrade target.
      const value = await api.getServerUpdate().catch(() => null);
      if (isActive()) setServer(value);
    },
    [enabled],
  );
  usePolling({ intervalMs: fast ? 2000 : 15_000, onPoll: poll });
  return [enabled ? server : null, setServer] as const;
}

/**
 * The update lifecycle across this desktop app and the server it uses. A desktop server is
 * one target; a desktop client upgrades its remote server first and restarts only once the
 * server is back on the new release; a browser upgrades the server, then reloads its UI.
 */
export function useUpgrade({ includeServer = true }: { includeServer?: boolean } = {}) {
  const desktop = desktopBridge();
  const state = useDesktopState();
  const scope = useClientScope();
  const [upgrading, setUpgrading] = useState(false);
  const [failure, setFailure] = useState<UpgradeFailure | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const serverRole = state?.role === "server";
  const [server, setServer] = useServerUpdate(
    includeServer && !serverRole && (!desktop || state !== null),
    upgrading || ["checking", "downloading"].includes(state?.update.state ?? ""),
  );
  useEffect(() => {
    if (checkedAt === null) return;
    const timer = setTimeout(() => setCheckedAt(null), upToDateMs);
    return () => clearTimeout(timer);
  }, [checkedAt]);

  const app = appTarget(state);
  const remote = apiTarget(server, state, scope);
  const targets = [app, remote].filter((target) => target !== null);
  const phase = phaseOf(targets, upgrading, failure, checkedAt !== null);

  const check = async () => {
    setFailure(null);
    const [, server] = await Promise.allSettled([
      app && desktop?.checkForUpdates(),
      remote && api.checkServerUpdate().then(setServer),
    ]);
    if (server.status === "rejected")
      setFailure({ title: "Server update check failed", message: describe(server.reason) });
    else setCheckedAt(Date.now());
  };

  const download = async () => {
    try {
      if (app?.update.state === "available")
        void desktop?.downloadUpdate().then((result) => {
          if (!result.ok) setFailure({ title: "Download failed", message: result.message });
        });
      if (remote?.update.state === "available") setServer(await api.downloadServerUpdate());
    } catch (cause) {
      setFailure({ title: "Server download failed", message: describe(cause) });
    }
  };

  const upgrade = async () => {
    const serverReady = remote?.update.state === "downloaded" ? remote : null;
    const localReady = app?.update.state === "downloaded" ? app : null;
    setFailure(null);
    setUpgrading(true);
    try {
      if (serverReady) {
        await api.installServerUpdate().catch((cause: unknown) => {
          // A lost reply may follow an accepted install: the restart itself answers.
          if (!(cause instanceof OfflineError && cause.delivery === "unknown")) throw cause;
        });
        await waitForServer(serverReady.update.version);
      }
    } catch (cause) {
      setUpgrading(false);
      setFailure({
        title: localReady ? "Server update failed · Client kept" : "Server update failed",
        message: describe(cause),
      });
      return;
    }
    if (!localReady) {
      // A browser receives the upgraded server's UI only by loading it again.
      if (!desktop) window.location.reload();
      setUpgrading(false);
      return;
    }
    const result = await desktop?.installUpdate();
    if (result && !result.ok) {
      setUpgrading(false);
      setFailure({ title: "Client update failed", message: result.message });
    }
  };

  return { targets, phase, failure, check, download, upgrade };
}

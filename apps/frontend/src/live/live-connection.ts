import { useEffect, useSyncExternalStore } from "react";
import { Layer } from "effect";
import { Socket } from "effect/socket";
import { LIVE_PATH } from "@t3-factory/contracts";
import { FACTORY_MINIMUM_SERVER_PROTOCOL, FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import { recheckAccess } from "../client-gate.tsx";
import { desktopBridge } from "../desktop-bridge.ts";
import { transport } from "../transport.ts";
import { desktopLiveSocket } from "./desktop-socket.ts";
import { LiveOwner, type LiveScope, type LiveScopeView } from "./owner.ts";
import { rpcSessions } from "./rpc-session.ts";
import { appearanceScope, connectionScope } from "./scopes.ts";

/** Browsers cannot set WebSocket headers, so the protocol range travels in the query. */
const liveQuery = new URLSearchParams({
  protocol: String(FACTORY_PROTOCOL),
  minimum: String(FACTORY_MINIMUM_SERVER_PROTOCOL),
}).toString();

/** The desktop renderer never opens a network socket: the main process relays one. */
function sessions() {
  if (desktopBridge())
    return rpcSessions(
      `${LIVE_PATH}?${liveQuery}`,
      Layer.succeed(Socket.WebSocketConstructor, (url) => desktopLiveSocket(url)),
    );
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return rpcSessions(
    `${scheme}://${location.host}${LIVE_PATH}?${liveQuery}`,
    Socket.layerWebSocketConstructorGlobal,
  );
}

/** Electron keeps a minimized window's document visible, so desktop reports minimizing itself. */
let minimized = false;
const windowVisible = () => document.visibilityState !== "hidden" && !minimized;
const gateOwnsWindow = () => {
  const kind = transport.get().kind;
  return kind === "access-lost" || kind === "incompatible";
};

let owner: LiveOwner | undefined;

/** Created on first use and kept for the window's lifetime, so its listeners never accumulate. */
function liveOwner(): LiveOwner {
  if (owner) return owner;
  const created = new LiveOwner({
    open: sessions(),
    setTimer(run, ms) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    random: Math.random,
    classify: () => void recheckAccess(),
    publish: (delivery) => transport.setLiveDelivery(delivery),
  });
  created.setVisible(windowVisible());
  created.setBlocked(gateOwnsWindow());
  // Window blur is deliberately ignored: a visible unfocused window keeps updating.
  document.addEventListener("visibilitychange", () => created.setVisible(windowVisible()));
  const desktop = desktopBridge();
  if (desktop) {
    const follow = (state: { readonly minimized: boolean }) => {
      minimized = state.minimized;
      created.setVisible(windowVisible());
    };
    void desktop.getState().then(follow);
    desktop.onState(follow);
  }
  transport.subscribe(() => created.setBlocked(gateOwnsWindow()));
  owner = created;
  return created;
}

/**
 * Holds `scope` while the calling component is mounted. Pass a stable scope: a module
 * constant, or one memoized per identity (for example per Run id).
 */
export function useLiveScope<M extends { readonly _tag: string }, V>(
  scope: LiveScope<M, V>,
): LiveScopeView<V> {
  const live = liveOwner();
  useEffect(() => live.acquire(scope), [live, scope]);
  return useSyncExternalStore(live.subscribe, () => live.view<V>(scope.key));
}

/** The backend's authoritative T3 connection status for this window. */
export const useLiveConnectionStatus = () => useLiveScope(connectionScope);

/** Theme-color status and presentation; mount only for servers that serve it. */
export const useLiveAppearance = () => useLiveScope(appearanceScope);

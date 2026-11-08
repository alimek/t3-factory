import { useSyncExternalStore } from "react";
import { FACTORY_MINIMUM_SERVER_PROTOCOL, FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import type { LiveDelivery } from "./live/owner.ts";

/**
 * What this client last learned about its server. `offline` keeps the last observed
 * screen but no mutation is sent or queued; `access-lost` and `incompatible` hand the
 * window back to the client gate.
 */
export type TransportState =
  | { readonly kind: "online"; readonly observedAt: number | null }
  | { readonly kind: "offline"; readonly observedAt: number | null }
  | { readonly kind: "access-lost" }
  | { readonly kind: "incompatible"; readonly message: string };

let state: TransportState = { kind: "online", observedAt: null };
/** Live scopes held by this window: product mutations wait until every one is current. */
let liveDelivery: LiveDelivery = "current";
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function publish(next: TransportState) {
  state = next;
  notify();
}

export const transport = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  observed() {
    const at = Date.now();
    // Successful polls refresh staleness at most once a second.
    if (
      state.kind === "offline" ||
      (state.kind === "online" && at - (state.observedAt ?? 0) >= 1000)
    )
      publish({ kind: "online", observedAt: at });
  },
  unreachable() {
    if (state.kind === "online" || state.kind === "offline")
      publish({ kind: "offline", observedAt: state.observedAt });
  },
  accessLost: () => publish({ kind: "access-lost" }),
  incompatible: (message: string) => publish({ kind: "incompatible", message }),
  /** The gate re-established access; product requests may resume. */
  reset: () => publish({ kind: "online", observedAt: Date.now() }),
  liveDelivery: () => liveDelivery,
  setLiveDelivery(next: LiveDelivery) {
    if (next === liveDelivery) return;
    liveDelivery = next;
    notify();
  },
  /** Mutations are sent only while reachable and every live scope reflects the current state. */
  acceptsMutations: () => state.kind === "online" && liveDelivery === "current",
};

export function useTransport(): TransportState {
  return useSyncExternalStore(transport.subscribe, transport.get, transport.get);
}

export function useLiveDelivery(): LiveDelivery {
  return useSyncExternalStore(transport.subscribe, transport.liveDelivery, transport.liveDelivery);
}

/** Every request declares this bundle's protocol range before the server runs an operation. */
export const protocolHeaders = {
  "X-Factory-Protocol": String(FACTORY_PROTOCOL),
  "X-Factory-Protocol-Minimum": String(FACTORY_MINIMUM_SERVER_PROTOCOL),
} as const;

/** Distinguish a locally refused command from a request whose response was lost. */
export class OfflineError extends Error {
  constructor(readonly delivery: "not-sent" | "unknown" = "unknown") {
    super(
      delivery === "not-sent"
        ? "Factory is offline. Nothing was sent; reconnect and check the current state first."
        : "Factory lost the connection. The server may have accepted the request; reconnect and check its outcome before retrying.",
    );
  }
}

/** The desktop transport answers this way when it cannot reach the selected server. */
export const unreachableHeader = "x-factory-transport";

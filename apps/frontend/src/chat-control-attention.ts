import { useEffect, useSyncExternalStore } from "react";
import type { DiscordSettings } from "@t3-factory/contracts";
import { api } from "./api.ts";

let needsAttention = false;
const listeners = new Set<() => void>();

/** Records the latest Discord settings the host returned, for the Settings navigation indicator. */
export function reportDiscordSettings(settings: DiscordSettings) {
  if (settings.needsAttention === needsAttention) return;
  needsAttention = settings.needsAttention;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Whether the Discord page's navigation item shows its indicator: a current unresolved Chat
 * control failure while On. `read` reads the host's settings once, for the host only.
 */
export function useDiscordAttention(read: boolean) {
  useEffect(() => {
    if (read) void api.getDiscordSettings().then(reportDiscordSettings, () => undefined);
  }, [read]);
  return useSyncExternalStore(subscribe, () => needsAttention);
}

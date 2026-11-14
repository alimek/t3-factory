import { useEffect, useSyncExternalStore } from "react";
import type { ChatModelSettings, DiscordSettings } from "@t3-factory/contracts";
import { api } from "./api.ts";

/**
 * Whether one Chat control page's navigation item shows its indicator: a current unresolved
 * failure on that page while Chat control is On, as the host last reported it.
 */
function attentionStore<Settings extends { readonly needsAttention: boolean }>(
  read: () => Promise<Settings>,
) {
  let needsAttention = false;
  const listeners = new Set<() => void>();
  const report = (settings: Settings) => {
    if (settings.needsAttention === needsAttention) return;
    needsAttention = settings.needsAttention;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  /** `read` reads the host's settings once, for the host only. */
  const useAttention = (shouldRead: boolean) => {
    useEffect(() => {
      if (shouldRead) void read().then(report, () => undefined);
    }, [shouldRead]);
    return useSyncExternalStore(subscribe, () => needsAttention);
  };
  return { report, useAttention };
}

const discord = attentionStore<DiscordSettings>(() => api.getDiscordSettings());
const model = attentionStore<ChatModelSettings>(() => api.getChatModelSettings());

/** Records the latest Discord settings the host returned. */
export const reportDiscordSettings = discord.report;
export const useDiscordAttention = discord.useAttention;
/** Records the latest Language model settings the host returned. */
export const reportChatModelSettings = model.report;
export const useChatModelAttention = model.useAttention;

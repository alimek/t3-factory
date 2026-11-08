import type { NavigationLiveMessage, RunNavigationEntry } from "@t3-factory/contracts";
import { useLiveScope } from "./live-connection.ts";
import type { LiveScope } from "./owner.ts";

export const navigationScope: LiveScope<NavigationLiveMessage, readonly RunNavigationEntry[]> = {
  key: "navigation",
  watch: { rpc: "WatchNavigation" },
  snapshot: (message) => message.rows,
  apply: (rows, message) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of message.upserts) byId.set(row.id, row);
    for (const id of message.removals) byId.delete(id);
    // Match SQLite's ORDER BY created_at DESC, creation_key (binary collation).
    return [...byId.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.creationKey < b.creationKey ? -1 : a.creationKey > b.creationKey ? 1 : 0;
    });
  },
};

export const useLiveNavigation = () => useLiveScope(navigationScope);

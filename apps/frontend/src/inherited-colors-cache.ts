/**
 * This client's cached theme colors: the one dual-mode presentation its Factory server last
 * published, kept in the browser profile's (or the desktop installation's) storage for this
 * Factory origin so an approved client shows them before live delivery answers and while it
 * is offline. It holds no credential, and both modes live in the same snapshot.
 */
import type { AppearancePresentation, AppearanceSource } from "@t3-factory/contracts";
import { parseAppearancePresentation } from "@t3-factory/domain-validation";

const storageKey = "factory.inherited-colors";

type ProfileStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Null when the profile blocks storage; the client then simply waits for live delivery. */
export function profileStorage(): ProfileStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The snapshot to show for `serverId`, or null: one stored for another Factory server, from
 * another source than the server's current `source` (its T3 environment, grant and resolver),
 * past its grant's expiry or not exactly a sanitized presentation is never used. Call this only
 * once the server has confirmed this client's access and declared that source.
 */
export function cachedColors(
  storage: ProfileStorage | null,
  serverId: string,
  source: AppearanceSource | null,
  now: number,
): AppearancePresentation | null {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (typeof stored !== "object" || stored === null) return null;
    const { version, serverId: server, presentation } = stored as Record<string, unknown>;
    if (version !== 1 || server !== serverId || !source) return null;
    const snapshot = parseAppearancePresentation(presentation);
    return snapshot &&
      snapshot.environmentId === source.environmentId &&
      snapshot.grant.id === source.grantId &&
      snapshot.resolverPin === source.resolverPin &&
      now < Date.parse(snapshot.grant.expiresAt)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

/** Replaces the cached snapshot with the presentation `serverId` published. */
export function rememberColors(
  storage: ProfileStorage | null,
  serverId: string,
  presentation: AppearancePresentation,
) {
  try {
    storage?.setItem(storageKey, JSON.stringify({ version: 1, serverId, presentation }));
  } catch {
    // Blocked or full storage: the colors still apply for this session.
  }
}

/**
 * Removes the cached snapshot: the server ended inheritance (expiry, revocation, disconnect,
 * another source, no inherited theme) or this client has no approved access.
 */
export function forgetColors(storage: ProfileStorage | null) {
  try {
    storage?.removeItem(storageKey);
  } catch {
    // Nothing was readable, so nothing is kept.
  }
}

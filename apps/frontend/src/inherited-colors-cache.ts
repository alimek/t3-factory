/**
 * This client's cached theme colors: the one dual-mode presentation its Factory server last
 * published, kept in the browser profile's (or the desktop installation's) storage for this
 * Factory origin so an approved client shows them before live delivery answers and while it
 * is offline. It holds no credential, and both modes live in the same snapshot.
 */
import type { AppearancePresentation, AppearanceSource, T3Appearance } from "@t3-factory/contracts";
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
 * The colors a client may keep showing once its server declares `source`: only those that came
 * from exactly that T3 environment, grant and resolver. A disconnect, another pairing or
 * another T3 source therefore ends them at the access check, before live delivery answers.
 */
function colorsOfSource(
  presentation: AppearancePresentation | null,
  source: AppearanceSource | null,
): AppearancePresentation | null {
  return presentation &&
    source &&
    presentation.environmentId === source.environmentId &&
    presentation.grant.id === source.grantId &&
    presentation.resolverPin === source.resolverPin
    ? presentation
    : null;
}

/** What a mounted client follows for its theme colors. */
export interface FollowedColors {
  /** The source the server declared at its latest access check. */
  readonly declared: AppearanceSource | null;
  /** The cached snapshot of that source, shown until the server publishes. */
  readonly cached: AppearancePresentation | null;
  /** The server's status this client took from live delivery. */
  readonly published: T3Appearance | null;
  /** A delivery that carried another source's colors when `declared` replaced that source. */
  readonly refused: T3Appearance | null;
}

/**
 * Follows one render of a mounted client. An access check and live delivery are not ordered
 * against each other, so when the server declares another source, the delivery held at that
 * moment is refused if it still carries the replaced source's colors: staying synchronized does
 * not make it newer than the access check. Every later delivery is the server's current state
 * and is taken; colors of the same source are kept through an outage.
 */
export function followColors(
  followed: FollowedColors,
  source: AppearanceSource | null,
  live: { readonly value: T3Appearance | null; readonly synchronized: boolean },
): FollowedColors {
  let { declared, cached, published, refused } = followed;
  if (source !== declared) {
    const replaced = (appearance: T3Appearance | null) =>
      appearance?.presentation && !colorsOfSource(appearance.presentation, source);
    declared = source;
    cached = colorsOfSource(cached, source);
    if (replaced(published)) published = null;
    refused = replaced(live.value) ? live.value : null;
  }
  if (live.synchronized && live.value && live.value !== refused && live.value !== published) {
    published = live.value;
    refused = null;
  }
  return declared === followed.declared &&
    cached === followed.cached &&
    published === followed.published &&
    refused === followed.refused
    ? followed
    : { declared, cached, published, refused };
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
    if (version !== 1 || server !== serverId) return null;
    const snapshot = colorsOfSource(parseAppearancePresentation(presentation), source);
    return snapshot && now < Date.parse(snapshot.grant.expiresAt) ? snapshot : null;
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

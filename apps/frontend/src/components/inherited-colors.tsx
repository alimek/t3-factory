import { useEffect, useState } from "react";
import { applyInheritedColors } from "../appearance.ts";
import { useAppearanceSource, useServerId, useServerInheritsAppearance } from "../client-scope.ts";
import {
  cachedColors,
  followColors,
  type FollowedColors,
  forgetColors,
  profileStorage,
  rememberColors,
} from "../inherited-colors-cache.ts";
import { useLiveAppearance } from "../live/live-connection.ts";

const expiryCheckMs = 60_000;

/**
 * Shows one server's theme colors while product screens are mounted: its cached snapshot of
 * the source the server declared at the access check until live delivery answers, then exactly
 * what the server publishes. A value live delivery kept from before a reconnect is not trusted
 * until the current subscription confirms it, and colors already shown or still held by live
 * delivery are dropped when a later access check declares another source, so a replaced server
 * or source cannot keep or bring back an old palette.
 */
function FollowInheritedColors({ serverId }: { serverId: string }) {
  const live = useLiveAppearance();
  const source = useAppearanceSource();
  const [followed, setFollowed] = useState<FollowedColors>(() => ({
    declared: source,
    cached: cachedColors(profileStorage(), serverId, source, Date.now()),
    published: null,
    refused: null,
  }));
  // Every access check declares the server's source again, also while this client stays
  // mounted through a reconnect, so the colors are followed during render.
  const current = followColors(followed, source, live);
  if (current !== followed) setFollowed(current);
  const { published } = current;
  const presentation = published ? published.presentation : current.cached;
  useEffect(() => {
    if (!published) return;
    if (published.presentation) rememberColors(profileStorage(), serverId, published.presentation);
    else forgetColors(profileStorage());
  }, [published, serverId]);
  useEffect(() => {
    if (!presentation) return;
    const expiresAt = Date.parse(presentation.grant.expiresAt);
    // An offline client keeps the colors only while their grant is still valid.
    const expire = () => {
      if (Date.now() < expiresAt) return false;
      applyInheritedColors(null);
      forgetColors(profileStorage());
      return true;
    };
    if (expire()) return;
    applyInheritedColors(presentation);
    const timer = setInterval(expire, expiryCheckMs);
    return () => {
      clearInterval(timer);
      applyInheritedColors(null);
    };
  }, [presentation]);
  return null;
}

/** Approved product screens only: gates and unapproved screens never read or receive theme colors. */
export function InheritedColors() {
  const serverId = useServerId();
  return useServerInheritsAppearance() && serverId ? (
    <FollowInheritedColors key={serverId} serverId={serverId} />
  ) : null;
}

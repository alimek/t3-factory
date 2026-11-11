import { useEffect, useState } from "react";
import type { T3Appearance } from "@t3-factory/contracts";
import { applyInheritedColors } from "../appearance.ts";
import { useAppearanceSource, useServerId, useServerInheritsAppearance } from "../client-scope.ts";
import {
  cachedColors,
  forgetColors,
  profileStorage,
  rememberColors,
} from "../inherited-colors-cache.ts";
import { useLiveAppearance } from "../live/live-connection.ts";

const expiryCheckMs = 60_000;

/**
 * Shows one server's theme colors while product screens are mounted: its cached snapshot of
 * the source the server declared at the access check until live delivery answers, then exactly
 * what the server publishes. A value live delivery kept
 * from before a reconnect is not trusted until the current subscription confirms it, so a
 * replaced server or source cannot bring an old palette back.
 */
function FollowInheritedColors({ serverId }: { serverId: string }) {
  const live = useLiveAppearance();
  const source = useAppearanceSource();
  const [cached] = useState(() => cachedColors(profileStorage(), serverId, source, Date.now()));
  const [published, setPublished] = useState<T3Appearance | null>(null);
  if (live.synchronized && live.value && live.value !== published) setPublished(live.value);
  const presentation = published ? published.presentation : cached;
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

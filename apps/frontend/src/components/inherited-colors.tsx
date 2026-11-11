import { useEffect } from "react";
import { applyInheritedColors } from "../appearance.ts";
import { useServerInheritsAppearance } from "../client-scope.ts";
import { useLiveAppearance } from "../live/live-connection.ts";

const expiryCheckMs = 60_000;

/** Follows the server's theme-color presentation while product screens are mounted. */
function FollowInheritedColors() {
  const presentation = useLiveAppearance().value?.presentation ?? null;
  useEffect(() => {
    if (!presentation) return;
    const expiresAt = Date.parse(presentation.grant.expiresAt);
    if (Date.now() >= expiresAt) return;
    applyInheritedColors(presentation);
    // An offline client keeps the last colors only while their grant is still valid.
    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) applyInheritedColors(null);
    }, expiryCheckMs);
    return () => {
      clearInterval(timer);
      applyInheritedColors(null);
    };
  }, [presentation]);
  return null;
}

/** Approved product screens only: gates and unapproved screens never receive theme colors. */
export function InheritedColors() {
  return useServerInheritsAppearance() ? <FollowInheritedColors /> : null;
}

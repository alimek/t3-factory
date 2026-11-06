import { useEffect, useState } from "react";
import { desktopBridge, type DesktopState } from "./desktop-bridge.ts";

/** Current native state; null until the first read, and always null in a browser. */
export function useDesktopState(): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);
  useEffect(() => {
    const desktop = desktopBridge();
    if (!desktop) return;
    let active = true;
    void desktop.getState().then((value) => active && setState(value));
    const unsubscribe = desktop.onState((value) => active && setState(value));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}

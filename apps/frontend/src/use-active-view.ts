import { useEffect, useRef } from "react";

/** Async mutations may finish after the user has left their initiating editor. */
export function useActiveView() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}

import { useEffect, useSyncExternalStore } from "react";

const storageKey = "factory.runInspectorOpen";
const listeners = new Set<() => void>();
let open: boolean | undefined;
let hosts = 0;

/** Until the viewer chooses, the inspector starts open where it fits beside the canvas. */
function readOpen() {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true" || stored === "false") return stored === "true";
  } catch {
    // Storage unavailable: fall back to the responsive default.
  }
  return window.matchMedia("(min-width: 1280px)").matches;
}

function getOpen() {
  open ??= readOpen();
  return open;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setOpen(next: boolean) {
  open = next;
  try {
    window.localStorage.setItem(storageKey, String(next));
  } catch {
    // Storage unavailable: the choice applies for this session.
  }
  for (const listener of listeners) listener();
}

/** Shows or hides the inspector of the Run open in detail; elsewhere there is nothing to toggle. */
export function toggleRunInspector() {
  if (hosts > 0) setOpen(!getOpen());
}

/**
 * The docked inspector's open state: one per-viewer preference, independent of block selection
 * and of which Run is open. Mounting this hook makes the toggle command available.
 */
export function useRunInspectorOpen() {
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
    };
  }, []);
  return useSyncExternalStore(subscribe, getOpen, () => false);
}

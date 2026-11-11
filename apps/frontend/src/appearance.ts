/**
 * Factory's Light/Dark appearance: the one place that reads, applies and saves the mode.
 * The mode lives on `<html data-appearance>`, which every color token in styles.css follows.
 * A browser profile keeps it in this origin's localStorage (public/appearance.js applies it
 * before first paint); the desktop app keeps it per installation and serves the page in it.
 */
import { useSyncExternalStore } from "react";
import type { Appearance } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "./desktop-bridge.ts";

const storageKey = "factory.appearance";
const listeners = new Set<() => void>();

function currentAppearance(): Appearance {
  return document.documentElement.dataset.appearance === "light" ? "light" : "dark";
}

/** Browser chrome follows the canvas color the stylesheet resolved for this mode. */
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", color);
}

function apply(appearance: Appearance) {
  if (appearance === currentAppearance()) return;
  const root = document.documentElement;
  // Switch every color at once instead of letting each control's color transition run.
  root.dataset.appearanceChanging = "";
  root.dataset.appearance = appearance;
  syncThemeColor();
  // Reading layout commits the new colors before transitions are allowed again.
  void root.offsetHeight;
  delete root.dataset.appearanceChanging;
  for (const listener of listeners) listener();
}

/** Applies the document's mode to browser metadata and follows other tabs of this profile. */
export function startAppearance() {
  syncThemeColor();
  if (desktopBridge()) return;
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    apply(event.newValue === "light" ? "light" : "dark");
  });
}

/**
 * Applies the mode immediately, then saves it for this installation or browser profile.
 * Returns a message when it could not be saved; the mode then stays for this session only
 * in a browser, and reverts in the desktop app, whose native chrome did not change.
 */
export async function chooseAppearance(appearance: Appearance): Promise<string | null> {
  const previous = currentAppearance();
  apply(appearance);
  const desktop = desktopBridge();
  if (desktop) {
    const result = await desktop.setAppearance(appearance);
    if (result.ok) return null;
    apply(previous);
    return result.message;
  }
  try {
    window.localStorage.setItem(storageKey, appearance);
    return null;
  } catch {
    return "This browser blocks saved settings, so the appearance applies until this tab closes.";
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, currentAppearance);
}

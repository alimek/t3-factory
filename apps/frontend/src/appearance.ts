/**
 * Factory's Light/Dark appearance: the one place that reads, applies and saves the mode.
 * The mode lives on `<html data-appearance>`, which every color token in styles.css follows.
 * A browser profile keeps it in this origin's localStorage (public/appearance.js applies it
 * before first paint); the desktop app keeps it per installation and serves the page in it.
 */
import { useSyncExternalStore } from "react";
import { APPEARANCE_COLOR_TOKENS, type AppearancePresentation } from "@t3-factory/contracts";
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

/** Switches every color at once instead of letting each control's color transition run. */
function recolor(change: () => void) {
  const root = document.documentElement;
  root.dataset.appearanceChanging = "";
  change();
  syncThemeColor();
  // Reading layout commits the new colors before transitions are allowed again.
  void root.offsetHeight;
  delete root.dataset.appearanceChanging;
}

function apply(appearance: Appearance) {
  if (appearance === currentAppearance()) return;
  recolor(() => {
    document.documentElement.dataset.appearance = appearance;
  });
  for (const listener of listeners) listener();
}

const inheritedColorsId = "factory-inherited-colors";

/**
 * Overlays the inherited halves of `presentation` on the baseline, one rule per mode, so the
 * local mode keeps choosing between them and a baseline half simply has no rule. `null`
 * restores Factory's own colors. Values are set through the CSSOM, never parsed as CSS text.
 */
export function applyInheritedColors(presentation: AppearancePresentation | null) {
  recolor(() => {
    document.getElementById(inheritedColorsId)?.remove();
    if (!presentation) return;
    const style = document.createElement("style");
    style.id = inheritedColorsId;
    style.dataset.revision = presentation.revision;
    document.head.append(style);
    const sheet = style.sheet!;
    for (const mode of ["light", "dark"] as const) {
      const half = presentation.modes[mode];
      if (half.kind !== "inherited") continue;
      // `html:root` outranks the baseline's `:root[data-appearance]` regardless of order.
      const index = sheet.insertRule(
        `html:root[data-appearance="${mode}"] {}`,
        sheet.cssRules.length,
      );
      const rule = sheet.cssRules[index] as CSSStyleRule;
      for (const token of APPEARANCE_COLOR_TOKENS)
        rule.style.setProperty(`--${token}`, half.colors[token]);
    }
  });
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

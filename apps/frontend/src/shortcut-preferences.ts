import { useSyncExternalStore } from "react";
import {
  getDefaultShortcutBindings,
  getShortcutPlatform,
  formatShortcut,
  parseShortcutStorage,
  validateShortcutBinding,
  type ParsedShortcutStorage,
  type ShortcutBinding,
  type ShortcutBindings,
  type ShortcutId,
} from "./keyboard-shortcuts.ts";

const storageKey = "factory.keyboardShortcuts";
type Preferences = {
  bindings: ShortcutBindings;
  conflicts: ShortcutId[];
  storageIssue?: string | undefined;
  recording: boolean;
  sessionOnly: boolean;
};
const initial: Preferences = {
  bindings: getDefaultShortcutBindings(),
  conflicts: [],
  recording: false,
  sessionOnly: false,
};
let preferences = initial;
let loaded = false;
const listeners = new Set<() => void>();

function readStorage(raw: string): ParsedShortcutStorage | undefined {
  return parseShortcutStorage(raw, getShortcutPlatform());
}
function emit() {
  for (const listener of listeners) listener();
}
function loadPreferences() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = readStorage(raw);
      if (parsed) {
        preferences = { ...preferences, ...parsed };
        if (!parsed.storageIssue) persist(parsed.bindings, parsed.conflicts);
      } else
        preferences = {
          ...preferences,
          bindings: getDefaultShortcutBindings(),
          conflicts: [],
          storageIssue: "Stored keyboard shortcuts could not be restored. Defaults are in use.",
        };
    } else persist(preferences.bindings, preferences.conflicts);
  } catch {
    preferences = { ...preferences, sessionOnly: true };
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    try {
      const parsed = event.newValue ? readStorage(event.newValue) : undefined;
      preferences = {
        ...preferences,
        bindings: parsed?.bindings ?? getDefaultShortcutBindings(),
        conflicts: parsed?.conflicts ?? [],
        storageIssue:
          parsed?.storageIssue ??
          (event.newValue && !parsed
            ? "Stored keyboard shortcuts could not be restored. Defaults are in use."
            : undefined),
      };
      emit();
    } catch {
      preferences = {
        ...preferences,
        bindings: getDefaultShortcutBindings(),
        conflicts: [],
        storageIssue: "Stored keyboard shortcuts could not be restored. Defaults are in use.",
      };
      emit();
    }
  });
}
export function getShortcutPreferences() {
  loadPreferences();
  return preferences;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useShortcutPreferences() {
  const state = useSyncExternalStore(subscribe, getShortcutPreferences, () => initial);
  return {
    ...state,
    hint: (id: ShortcutId) => formatShortcut(state.bindings[id]),
    isConflict: (id: ShortcutId) => state.conflicts.includes(id),
  };
}
function persist(bindings: ShortcutBindings, conflicts: ShortcutId[]) {
  loadPreferences();
  preferences = {
    bindings,
    conflicts,
    recording: preferences.recording,
    sessionOnly: preferences.sessionOnly,
  };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ version: 2, bindings, conflicts }));
    preferences = { ...preferences, sessionOnly: false };
  } catch {
    preferences = { ...preferences, sessionOnly: true };
  }
  emit();
}
export function saveShortcutBinding(id: ShortcutId, binding: ShortcutBinding) {
  const current = getShortcutPreferences();
  const trial = { ...current.bindings, [id]: binding };
  const error = validateShortcutBinding(id, binding, trial);
  if (error) return error;
  persist(
    trial,
    current.conflicts.filter((entry) => entry !== id),
  );
  return undefined;
}
/** Resetting one command can conflict with a binding moved onto its default. */
export function resetShortcutBindings(id?: ShortcutId) {
  const defaults = getDefaultShortcutBindings();
  if (id) {
    const target = defaults[id];
    if (!target) {
      const current = getShortcutPreferences();
      persist(
        { ...current.bindings, [id]: null },
        current.conflicts.filter((entry) => entry !== id),
      );
      return undefined;
    }
    return saveShortcutBinding(id, target);
  }
  persist(defaults, []);
  return undefined;
}
export function setShortcutRecording(recording: boolean) {
  preferences = { ...getShortcutPreferences(), recording };
  emit();
}

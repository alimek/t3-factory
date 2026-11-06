import { useSyncExternalStore } from "react";
import {
  defaultShortcutBindings,
  formatShortcut,
  shortcutDefinitions,
  validateShortcutBinding,
  type ShortcutBinding,
  type ShortcutBindings,
  type ShortcutId,
} from "./keyboard-shortcuts.ts";

const storageKey = "factory.keyboardShortcuts";
type Preferences = { bindings: ShortcutBindings; recording: boolean; sessionOnly: boolean };
const initial: Preferences = {
  bindings: defaultShortcutBindings,
  recording: false,
  sessionOnly: false,
};
let preferences = initial;
let loaded = false;
const listeners = new Set<() => void>();

function readBindings(raw: string): ShortcutBindings | undefined {
  const data: unknown = JSON.parse(raw);
  if (
    !data ||
    typeof data !== "object" ||
    !("version" in data) ||
    data.version !== 1 ||
    !("bindings" in data) ||
    !data.bindings ||
    typeof data.bindings !== "object"
  )
    return undefined;
  const bindings = data.bindings as Record<string, unknown>;
  const result = {} as ShortcutBindings;
  for (const { id } of shortcutDefinitions) {
    const value = bindings[id];
    if (
      !value ||
      typeof value !== "object" ||
      !("key" in value) ||
      typeof value.key !== "string" ||
      !("mod" in value) ||
      typeof value.mod !== "boolean" ||
      !("alt" in value) ||
      typeof value.alt !== "boolean" ||
      !("shift" in value) ||
      typeof value.shift !== "boolean"
    )
      return undefined;
    result[id] = { key: value.key, mod: value.mod, alt: value.alt, shift: value.shift };
  }
  return shortcutDefinitions.some(({ id }) => validateShortcutBinding(id, result[id], result))
    ? undefined
    : result;
}
function emit() {
  for (const listener of listeners) listener();
}
function loadPreferences() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw)
      preferences = { ...preferences, bindings: readBindings(raw) ?? defaultShortcutBindings };
  } catch (error) {
    // A malformed value is safe to ignore; inaccessible storage needs a visible notice.
    if (!(error instanceof SyntaxError)) preferences = { ...preferences, sessionOnly: true };
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    try {
      const bindings = event.newValue ? readBindings(event.newValue) : defaultShortcutBindings;
      preferences = { ...preferences, bindings: bindings ?? defaultShortcutBindings };
      emit();
    } catch {
      preferences = { ...preferences, bindings: defaultShortcutBindings };
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
  return { ...state, hint: (id: ShortcutId) => formatShortcut(state.bindings[id]) };
}
function persist(bindings: ShortcutBindings) {
  loadPreferences();
  preferences = { ...preferences, bindings };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, bindings }));
    preferences = { ...preferences, sessionOnly: false };
  } catch {
    preferences = { ...preferences, sessionOnly: true };
  }
  emit();
}
export function saveShortcutBinding(id: ShortcutId, binding: ShortcutBinding) {
  const error = validateShortcutBinding(id, binding, getShortcutPreferences().bindings);
  if (error) return error;
  persist({ ...preferences.bindings, [id]: binding });
  return undefined;
}
/** Resetting one command can conflict with a binding moved onto its default. */
export function resetShortcutBindings(id?: ShortcutId) {
  if (id) return saveShortcutBinding(id, defaultShortcutBindings[id]);
  persist(defaultShortcutBindings);
  return undefined;
}
export function setShortcutRecording(recording: boolean) {
  preferences = { ...getShortcutPreferences(), recording };
  emit();
}

/** One registry supplies matching, validation and every editable shortcut hint. */
export const shortcutDefinitions = [
  { id: "palette", label: "Command palette", scope: "global" },
  { id: "settings", label: "Settings", scope: "global" },
  { id: "newRun", label: "New Run", scope: "global" },
  { id: "zoomIn", label: "Zoom in", scope: "canvas" },
  { id: "zoomOut", label: "Zoom out", scope: "canvas" },
  { id: "fit", label: "Fit canvas", scope: "canvas" },
] as const;
export type ShortcutId = (typeof shortcutDefinitions)[number]["id"];
export type ShortcutBinding = { key: string; mod: boolean; alt: boolean; shift: boolean };
export type ShortcutBindings = Record<ShortcutId, ShortcutBinding>;
export const defaultShortcutBindings: ShortcutBindings = {
  palette: { key: "k", mod: true, alt: false, shift: false },
  settings: { key: ",", mod: true, alt: false, shift: false },
  newRun: { key: "n", mod: true, alt: true, shift: false },
  zoomIn: { key: "=", mod: false, alt: false, shift: false },
  zoomOut: { key: "-", mod: false, alt: false, shift: false },
  fit: { key: "0", mod: false, alt: false, shift: false },
};

function isMacPlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
}

const physicalKeys: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: " ",
};
function eventKey(event: Pick<KeyboardEvent, "key" | "code">) {
  if (event.key === "Dead" || (event.key.length === 1 && event.key.charCodeAt(0) > 127)) {
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
    return physicalKeys[event.code] ?? event.key;
  }
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function shouldHandleShortcut(event: KeyboardEvent) {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.getModifierState("AltGraph")
  );
}

/** Explain modifier combinations the platform matcher cannot use. */
export function shortcutModifierError(event: KeyboardEvent) {
  if (event.getModifierState("AltGraph"))
    return "AltGr is used for typing characters. Choose a combination without AltGr.";
  if (isMacPlatform() ? event.ctrlKey : event.metaKey)
    return "Use Command on macOS or Control on Windows/Linux, without the other modifier.";
  return undefined;
}

/** '+' and '=' are one chord, including the Shift needed to print '+' on US keyboards. */
export function shortcutFromEvent(event: KeyboardEvent): ShortcutBinding | undefined {
  if (!shouldHandleShortcut(event) || shortcutModifierError(event)) return undefined;
  const key = eventKey(event);
  if (["Control", "Meta", "Alt", "Shift", "AltGraph", "Dead", "Unidentified"].includes(key))
    return undefined;
  return {
    key: key === "+" ? "=" : key,
    mod: isMacPlatform() ? event.metaKey : event.ctrlKey,
    alt: event.altKey,
    shift: key === "+" ? false : event.shiftKey,
  };
}
function sameBinding(left: ShortcutBinding, right: ShortcutBinding) {
  return (
    left.key === right.key &&
    left.mod === right.mod &&
    left.alt === right.alt &&
    left.shift === right.shift
  );
}
export function matchesShortcut(event: KeyboardEvent, binding: ShortcutBinding) {
  const candidate = shortcutFromEvent(event);
  return !!candidate && sameBinding(candidate, binding);
}

const fixedKeys = new Set([
  "Escape",
  "Tab",
  "Enter",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "F2",
  "ContextMenu",
]);
const supportedKey = (key: string) =>
  /^[\x20-\x7e]$/.test(key) ||
  /^F([1-9]|1[0-2])$/.test(key) ||
  ["Home", "End", "PageUp", "PageDown", "Insert"].includes(key);
const nativeModKeys = new Set([
  "a",
  "c",
  "v",
  "x",
  "z",
  "y",
  "f",
  "l",
  "n",
  "o",
  "p",
  "r",
  "s",
  "t",
  "w",
  "j",
  "h",
  "d",
  "u",
  "q",
  "e",
  "g",
  "b",
  "=",
  "-",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "[",
  "]",
]);
const browserKeys = new Set([
  "F1",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F10",
  "F11",
  "F12",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
]);
function bindingKeyError(binding: ShortcutBinding) {
  if (fixedKeys.has(binding.key))
    return "This key belongs to a fixed navigation or editing control. Choose another key.";
  if (
    !supportedKey(binding.key) ||
    (binding.key !== binding.key.toLowerCase() && binding.key.length === 1) ||
    binding.key === "+"
  )
    return "Choose a letter, number, punctuation key or function key.";
  if (binding.key === "=" && binding.shift)
    return "Plus and equals share one shortcut. Press + or = without extra Shift modifiers.";
  return undefined;
}
function isBrowserReserved(binding: ShortcutBinding) {
  if (browserKeys.has(binding.key)) return true;
  if (!binding.mod) return false;
  if (isMacPlatform() && !binding.alt && ["m", "i"].includes(binding.key)) return true;
  if (binding.shift && ["i", "k", "m"].includes(binding.key)) return true;
  return binding.alt && ["i", "j", "c", "u", "b", "l"].includes(binding.key);
}
export function validateShortcutBinding(
  id: ShortcutId,
  binding: ShortcutBinding,
  bindings: ShortcutBindings,
): string | undefined {
  const keyError = bindingKeyError(binding);
  if (keyError) return keyError;
  const definition = shortcutDefinitions.find((item) => item.id === id)!;
  if (definition.scope === "global" && !binding.mod)
    return "Global shortcuts need Command on macOS or Control elsewhere. Hold that modifier and press another key.";
  if (!binding.mod && binding.alt)
    return "Canvas shortcuts need a bare key or Command/Control. Remove Alt or add Command/Control.";
  // Native text editing, browser navigation and browser zoom keep their normal meaning.
  if (binding.mod && !binding.alt && nativeModKeys.has(binding.key))
    return "This combination is reserved for browser navigation or text editing. Add Alt or choose another key.";
  if (isBrowserReserved(binding))
    return "This combination is reserved by the browser. Choose another key.";
  const conflict = shortcutDefinitions.find(
    (other) => other.id !== id && sameBinding(binding, bindings[other.id]),
  );
  return conflict
    ? `Already used by ${conflict.label}. Change that shortcut first or choose another combination.`
    : undefined;
}
export function formatShortcut(binding: ShortcutBinding) {
  const key =
    binding.key === "="
      ? "+ / ="
      : binding.key === " "
        ? "Space"
        : binding.key.length === 1
          ? binding.key.toUpperCase()
          : binding.key;
  return [
    binding.mod ? (isMacPlatform() ? "⌘" : "Ctrl") : "",
    binding.alt ? "Alt" : "",
    binding.shift ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join(isMacPlatform() ? "" : "+");
}

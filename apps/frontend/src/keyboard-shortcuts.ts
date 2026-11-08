import { desktopBridge } from "./desktop-bridge.ts";

export type ShortcutPlatform = "desktop" | "browser";

export type ShortcutGroup = "application" | "navigation" | "runActions" | "canvas";

export const shortcutGroupLabels: Record<ShortcutGroup, string> = {
  application: "Application",
  navigation: "Navigation",
  runActions: "Open Run actions",
  canvas: "Canvas",
};

export const shortcutDefinitions = [
  { id: "palette", label: "Command palette", scope: "global", group: "application" },
  { id: "settings", label: "Settings", scope: "global", group: "application" },
  { id: "newRun", label: "New Run", scope: "global", group: "application" },
  { id: "searchRuns", label: "Search Runs", scope: "global", group: "application" },
  { id: "studio", label: "Studio", scope: "global", group: "application" },
  { id: "shortcutsCheatSheet", label: "Keyboard shortcuts", scope: "global", group: "application" },
  { id: "back", label: "Back", scope: "global", group: "navigation" },
  { id: "forward", label: "Forward", scope: "global", group: "navigation" },
  { id: "previousRun", label: "Previous Run", scope: "global", group: "navigation" },
  { id: "nextRun", label: "Next Run", scope: "global", group: "navigation" },
  { id: "openRow1", label: "Open row 1", scope: "global", group: "navigation" },
  { id: "openRow2", label: "Open row 2", scope: "global", group: "navigation" },
  { id: "openRow3", label: "Open row 3", scope: "global", group: "navigation" },
  { id: "openRow4", label: "Open row 4", scope: "global", group: "navigation" },
  { id: "openRow5", label: "Open row 5", scope: "global", group: "navigation" },
  { id: "openRow6", label: "Open row 6", scope: "global", group: "navigation" },
  { id: "openRow7", label: "Open row 7", scope: "global", group: "navigation" },
  { id: "openRow8", label: "Open row 8", scope: "global", group: "navigation" },
  { id: "openRow9", label: "Open row 9", scope: "global", group: "navigation" },
  { id: "snoozeRestore", label: "Snooze or restore Run", scope: "global", group: "runActions" },
  { id: "settle", label: "Settle Run", scope: "global", group: "runActions" },
  { id: "archive", label: "Archive Run…", scope: "global", group: "runActions" },
  { id: "rename", label: "Rename Run", scope: "contextual", group: "runActions" },
  { id: "zoomIn", label: "Zoom in", scope: "canvas", group: "canvas" },
  { id: "zoomOut", label: "Zoom out", scope: "canvas", group: "canvas" },
  { id: "fit", label: "Fit canvas", scope: "canvas", group: "canvas" },
] as const;

export type ShortcutId = (typeof shortcutDefinitions)[number]["id"];
export type ShortcutBinding = { key: string; mod: boolean; alt: boolean; shift: boolean };
export type ShortcutBindings = Record<ShortcutId, ShortcutBinding | null>;

/** The six commands and bindings persisted before storage version 2. */
const legacyV1ShortcutDefaults: Record<
  "palette" | "settings" | "newRun" | "zoomIn" | "zoomOut" | "fit",
  ShortcutBinding
> = {
  palette: { key: "k", mod: true, alt: false, shift: false },
  settings: { key: ",", mod: true, alt: false, shift: false },
  newRun: { key: "n", mod: true, alt: true, shift: false },
  zoomIn: { key: "=", mod: false, alt: false, shift: false },
  zoomOut: { key: "-", mod: false, alt: false, shift: false },
  fit: { key: "0", mod: false, alt: false, shift: false },
};

const legacyV1Ids = new Set(Object.keys(legacyV1ShortcutDefaults));

export function getShortcutPlatform(): ShortcutPlatform {
  return desktopBridge() ? "desktop" : "browser";
}

function binding(
  key: string,
  options: Partial<Omit<ShortcutBinding, "key">> = {},
): ShortcutBinding {
  return { key, mod: false, alt: false, shift: false, ...options };
}

const sharedPlatformDefaults = {
  palette: binding("k", { mod: true }),
  settings: binding(",", { mod: true }),
  previousRun: binding("ArrowUp", { mod: true, alt: true }),
  nextRun: binding("ArrowDown", { mod: true, alt: true }),
  studio: binding("s", { mod: true, shift: true }),
  shortcutsCheatSheet: binding("/", { mod: true }),
  snoozeRestore: binding("z", { mod: true, shift: true }),
  settle: binding("e", { mod: true, shift: true }),
  archive: binding("Backspace", { mod: true }),
  rename: binding("F2"),
  zoomIn: binding("="),
  zoomOut: binding("-"),
  fit: binding("0"),
} satisfies Partial<Record<ShortcutId, ShortcutBinding>>;

const desktopOnlyDefaults = {
  newRun: binding("n", { mod: true }),
  searchRuns: binding("f", { mod: true }),
  back: binding("[", { mod: true }),
  forward: binding("]", { mod: true }),
  openRow1: binding("1", { mod: true }),
  openRow2: binding("2", { mod: true }),
  openRow3: binding("3", { mod: true }),
  openRow4: binding("4", { mod: true }),
  openRow5: binding("5", { mod: true }),
  openRow6: binding("6", { mod: true }),
  openRow7: binding("7", { mod: true }),
  openRow8: binding("8", { mod: true }),
  openRow9: binding("9", { mod: true }),
} satisfies Partial<Record<ShortcutId, ShortcutBinding>>;

const browserOnlyDefaults = {
  newRun: binding("n", { mod: true, alt: true }),
  searchRuns: binding("f", { mod: true, shift: true }),
  back: null,
  forward: null,
  openRow1: null,
  openRow2: null,
  openRow3: null,
  openRow4: null,
  openRow5: null,
  openRow6: null,
  openRow7: null,
  openRow8: null,
  openRow9: null,
} satisfies Partial<Record<ShortcutId, ShortcutBinding | null>>;

export function getDefaultShortcutBindings(platform = getShortcutPlatform()): ShortcutBindings {
  const specific = platform === "desktop" ? desktopOnlyDefaults : browserOnlyDefaults;
  return shortcutDefinitions.reduce((result, { id }) => {
    result[id] =
      id in specific
        ? (specific[id as keyof typeof specific] ?? null)
        : (sharedPlatformDefaults[id as keyof typeof sharedPlatformDefaults] ?? null);
    return result;
  }, {} as ShortcutBindings);
}

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

export function shortcutModifierError(event: KeyboardEvent) {
  if (event.getModifierState("AltGraph"))
    return "AltGr is used for typing characters. Choose a combination without AltGr.";
  if (isMacPlatform() ? event.ctrlKey : event.metaKey)
    return "Use Command on macOS or Control on Windows/Linux, without the other modifier.";
  return undefined;
}

/** Plus and equals share a chord, including Shift used to print + on US keyboards. */
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

function sameShortcutBinding(left: ShortcutBinding, right: ShortcutBinding) {
  return (
    left.key === right.key &&
    left.mod === right.mod &&
    left.alt === right.alt &&
    left.shift === right.shift
  );
}

export function matchesShortcut(event: KeyboardEvent, binding: ShortcutBinding | null | undefined) {
  if (!binding) return false;
  const candidate = shortcutFromEvent(event);
  return !!candidate && sameShortcutBinding(candidate, binding);
}

const fixedKeys = new Set(["Escape", "Tab", "Enter", "Delete", "ContextMenu"]);

const supportedKey = (key: string) =>
  /^[\x20-\x7e]$/.test(key) ||
  /^F([1-9]|1[0-2])$/.test(key) ||
  [
    "Backspace",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
  ].includes(key);

const browserReservedModKeys = new Set([
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

const desktopReservedModKeys = new Set(
  [...browserReservedModKeys].filter(
    (key) => !["n", "1", "2", "3", "4", "5", "6", "7", "8", "9", "[", "]"].includes(key),
  ),
);

const browserFunctionKeys = new Set([
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

function isShortcutPlatformReserved(binding: ShortcutBinding, platform: ShortcutPlatform) {
  if (
    Object.values(getDefaultShortcutBindings(platform)).some(
      (candidate) => candidate && sameShortcutBinding(candidate, binding),
    )
  )
    return false;
  if (browserFunctionKeys.has(binding.key)) return true;
  if (!binding.mod) return false;
  const nativeModKeys = platform === "desktop" ? desktopReservedModKeys : browserReservedModKeys;
  if (!binding.alt && nativeModKeys.has(binding.key)) return true;
  if (isMacPlatform() && !binding.alt && ["m", "i"].includes(binding.key)) return true;
  if (binding.shift && ["i", "k", "m"].includes(binding.key)) return true;
  return binding.alt && ["i", "j", "c", "u", "b", "l"].includes(binding.key);
}

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

export function validateShortcutBinding(
  id: ShortcutId,
  binding: ShortcutBinding,
  bindings: ShortcutBindings,
  platform = getShortcutPlatform(),
): string | undefined {
  const keyError = bindingKeyError(binding);
  if (keyError) return keyError;
  const definition = shortcutDefinitions.find((item) => item.id === id)!;
  if (definition.scope === "global" && !binding.mod)
    return "Global shortcuts need Command on macOS or Control elsewhere. Hold that modifier and press another key.";
  if (definition.scope === "canvas" && !binding.mod && binding.alt)
    return "Canvas shortcuts need a bare key or Command/Control. Remove Alt or add Command/Control.";
  if (isShortcutPlatformReserved(binding, platform))
    return platform === "browser"
      ? "This combination is reserved by the browser. Choose another key."
      : "This combination is reserved for browser navigation or text editing. Add Alt or choose another key.";
  const conflict = shortcutDefinitions.find(
    (other) =>
      other.id !== id && bindings[other.id] && sameShortcutBinding(binding, bindings[other.id]!),
  );
  return conflict
    ? `Already used by ${conflict.label}. Change that shortcut first or choose another combination.`
    : undefined;
}

export function formatShortcut(binding: ShortcutBinding | null | undefined) {
  if (!binding) return "Unbound";
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

function bindingFingerprint(binding: ShortcutBinding) {
  return `${binding.mod}:${binding.alt}:${binding.shift}:${binding.key}`;
}

function isLegacyV1Default(id: ShortcutId, stored: ShortcutBinding) {
  return (
    legacyV1Ids.has(id) &&
    sameShortcutBinding(
      stored,
      legacyV1ShortcutDefaults[id as keyof typeof legacyV1ShortcutDefaults],
    )
  );
}

function placeShortcutBinding(
  id: ShortcutId,
  target: ShortcutBinding | null,
  occupied: Map<string, ShortcutId>,
  bindings: ShortcutBindings,
  conflicts: ShortcutId[],
) {
  if (!target) {
    bindings[id] = null;
    return;
  }
  const fingerprint = bindingFingerprint(target);
  if (occupied.has(fingerprint)) {
    bindings[id] = null;
    conflicts.push(id);
    return;
  }
  bindings[id] = target;
  occupied.set(fingerprint, id);
}

function parseBinding(value: unknown): ShortcutBinding | undefined {
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
  return { key: value.key, mod: value.mod, alt: value.alt, shift: value.shift };
}

export type ParsedShortcutStorage = {
  bindings: ShortcutBindings;
  conflicts: ShortcutId[];
  storageIssue?: string;
};

type StoredShortcutBlob = {
  version: unknown;
  bindings: unknown;
  conflicts?: unknown;
};

function readStoredConflicts(raw: unknown): ShortcutId[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is ShortcutId =>
      typeof entry === "string" && shortcutDefinitions.some(({ id }) => id === entry),
  );
}

const corruptStoredShortcutMessage =
  "Some stored shortcuts could not be restored. Valid preferences were kept.";

function restoreStoredBindings(
  source: Record<string, unknown>,
  platform: ShortcutPlatform,
  legacy: boolean,
) {
  const defaults = getDefaultShortcutBindings(platform);
  const bindings = Object.fromEntries(
    shortcutDefinitions.map(({ id }) => [id, null]),
  ) as ShortcutBindings;
  const occupied = new Map<string, ShortcutId>();
  const conflicts: ShortcutId[] = [];
  let storageIssue: string | undefined;
  const supplied = new Set<ShortcutId>();
  for (const { id } of shortcutDefinitions.filter(({ id }) => id in source)) {
    const value = source[id];
    const parsed = parseBinding(value);
    if (legacy && parsed && isLegacyV1Default(id, parsed)) continue;
    if (value === null && !legacy) {
      supplied.add(id);
      continue;
    }
    if (!parsed || validateShortcutBinding(id, parsed, bindings, platform)) {
      storageIssue = corruptStoredShortcutMessage;
      continue;
    }
    supplied.add(id);
    placeShortcutBinding(id, parsed, occupied, bindings, conflicts);
  }
  for (const { id } of shortcutDefinitions) {
    if (!supplied.has(id)) placeShortcutBinding(id, defaults[id], occupied, bindings, conflicts);
  }
  return { bindings, conflicts, ...(storageIssue ? { storageIssue } : {}) };
}

export function parseShortcutStorage(
  raw: string,
  platform = getShortcutPlatform(),
): ParsedShortcutStorage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || !("version" in data) || !("bindings" in data))
    return undefined;
  const stored = data as StoredShortcutBlob;
  if (stored.version !== 1 && stored.version !== 2) return undefined;
  if (!stored.bindings || typeof stored.bindings !== "object" || Array.isArray(stored.bindings))
    return {
      bindings: getDefaultShortcutBindings(platform),
      conflicts: [],
      storageIssue: corruptStoredShortcutMessage,
    };
  const result = restoreStoredBindings(
    stored.bindings as Record<string, unknown>,
    platform,
    stored.version === 1,
  );
  result.conflicts = [
    ...new Set([
      ...result.conflicts,
      ...readStoredConflicts(stored.conflicts).filter((id) => result.bindings[id] === null),
    ]),
  ];
  return result;
}

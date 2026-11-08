import { expect, it } from "vite-plus/test";
import {
  getDefaultShortcutBindings,
  parseShortcutStorage,
  shortcutDefinitions,
  type ShortcutBinding,
  type ShortcutPlatform,
  validateShortcutBinding,
} from "../src/keyboard-shortcuts.ts";

function modKey(key: string, extra: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return { key, mod: true, alt: false, shift: false, ...extra };
}

const v1Defaults = {
  palette: modKey("k"),
  settings: modKey(","),
  newRun: modKey("n", { alt: true }),
  zoomIn: { key: "=", mod: false, alt: false, shift: false },
  zoomOut: { key: "-", mod: false, alt: false, shift: false },
  fit: { key: "0", mod: false, alt: false, shift: false },
};

it.each([
  { platform: "desktop" as const, reserved: false },
  { platform: "browser" as const, reserved: true },
])("$platform reserves desktop New Run chord: $reserved", ({ platform, reserved }) => {
  // Arrange
  const defaults = getDefaultShortcutBindings(platform);

  // Act
  const error = validateShortcutBinding("newRun", modKey("n"), defaults, platform);

  // Assert
  expect(!!error).toBe(reserved);
});

function invalidDefaults(platform: ShortcutPlatform) {
  const defaults = getDefaultShortcutBindings(platform);
  return shortcutDefinitions.flatMap(({ id }) => {
    const binding = defaults[id];
    if (!binding) return [];
    const error = validateShortcutBinding(id, binding, defaults, platform);
    return error ? [{ id, error }] : [];
  });
}

it.each(["desktop", "browser"] as const)(
  "%s defaults can all be restored without reservation or conflict",
  (platform) => {
    // Arrange / Act
    const errors = invalidDefaults(platform);

    // Assert
    expect(errors).toEqual([]);
  },
);

it.each(["desktop", "browser"] as const)("%s uses period to follow active Blocks", (platform) => {
  // Arrange
  const expected = { key: ".", mod: false, alt: false, shift: false };

  // Act
  const defaults = getDefaultShortcutBindings(platform);

  // Assert
  expect(defaults.followActive).toEqual(expected);
});

it("v1 New Run left at its old default follows the desktop default", () => {
  // Arrange
  const raw = JSON.stringify({ version: 1, bindings: v1Defaults });

  // Act
  const restored = parseShortcutStorage(raw, "desktop");

  // Assert
  expect(restored?.bindings.newRun).toEqual(modKey("n"));
  expect(restored?.storageIssue).toBeUndefined();
});

it("a v1 custom binding takes priority over a new default", () => {
  // Arrange
  const raw = JSON.stringify({ version: 1, bindings: { ...v1Defaults, palette: modKey("/") } });

  // Act
  const restored = parseShortcutStorage(raw, "desktop");

  // Assert
  expect(restored?.bindings.palette).toEqual(modKey("/"));
  expect(restored?.bindings.shortcutsCheatSheet).toBeNull();
  expect(restored?.conflicts).toEqual(["shortcutsCheatSheet"]);
});

it("v2 retains a command left unbound by migration and its conflict notice", () => {
  // Arrange
  const raw = JSON.stringify({
    version: 2,
    bindings: {
      ...getDefaultShortcutBindings("desktop"),
      palette: modKey("/"),
      shortcutsCheatSheet: null,
    },
    conflicts: ["shortcutsCheatSheet"],
  });

  // Act
  const restored = parseShortcutStorage(raw, "desktop");

  // Assert
  expect(restored?.bindings.shortcutsCheatSheet).toBeNull();
  expect(restored?.conflicts).toEqual(["shortcutsCheatSheet"]);
  expect(restored?.storageIssue).toBeUndefined();
});

it("a corrupt binding does not discard other valid custom preferences", () => {
  // Arrange
  const raw = JSON.stringify({
    version: 2,
    bindings: {
      ...getDefaultShortcutBindings("browser"),
      settings: modKey("p", { alt: true }),
      palette: { key: 1, mod: true, alt: false, shift: false },
    },
  });

  // Act
  const restored = parseShortcutStorage(raw, "browser");

  // Assert
  expect(restored?.storageIssue).toMatch(/could not be restored/i);
  expect(restored?.bindings.settings).toEqual(modKey("p", { alt: true }));
});

it("duplicate stored chords are reported and cannot execute two commands", () => {
  // Arrange
  const raw = JSON.stringify({
    version: 2,
    bindings: {
      ...getDefaultShortcutBindings("browser"),
      settings: modKey("k"),
    },
  });

  // Act
  const restored = parseShortcutStorage(raw, "browser");

  // Assert
  expect(restored?.storageIssue).toMatch(/could not be restored/i);
  expect(restored?.bindings.palette).toEqual(modKey("k"));
  expect(restored?.bindings.settings).not.toEqual(modKey("k"));
});

it.each(["invalid JSON", '{"version":99,"bindings":{}}'])(
  "unreadable storage is rejected: %s",
  (raw) => {
    // Arrange / Act
    const restored = parseShortcutStorage(raw, "browser");

    // Assert
    expect(restored).toBeUndefined();
  },
);

it("null stored bindings produce a visible recovery issue", () => {
  // Arrange
  const raw = JSON.stringify({ version: 2, bindings: null });

  // Act
  const restored = parseShortcutStorage(raw, "browser");

  // Assert
  expect(restored?.storageIssue).toMatch(/could not be restored/i);
});

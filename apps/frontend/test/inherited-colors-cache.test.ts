import { assert, expect, it } from "vite-plus/test";
import { cachedColors, forgetColors, rememberColors } from "../src/inherited-colors-cache.ts";
import { oceanPresentation, memoryStorage } from "./support/inherited-colors.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const LATER = "2026-12-11T12:00:00.000Z";

it("a client reopening on the same Factory server reuses both halves of its cached theme colors", () => {
  // Arrange
  const storage = memoryStorage();
  rememberColors(storage, "server-a", oceanPresentation(LATER));

  // Act
  const cached = cachedColors(storage, "server-a", NOW);

  // Assert
  expect(cached).toStrictEqual(oceanPresentation(LATER));
});

it("theme colors cached from one Factory server are not shown on another", () => {
  // Arrange
  const storage = memoryStorage();
  rememberColors(storage, "server-a", oceanPresentation(LATER));

  // Act
  const cached = cachedColors(storage, "server-b", NOW);

  // Assert
  expect(cached).toBe(null);
});

it("cached theme colors are not reused once their grant has expired", () => {
  // Arrange
  const storage = memoryStorage();
  rememberColors(storage, "server-a", oceanPresentation("2026-11-11T12:00:00.000Z"));

  // Act
  const cached = cachedColors(storage, "server-a", NOW);

  // Assert
  expect(cached).toBe(null);
});

it("a cached snapshot whose colors were altered in storage is not applied", () => {
  // Arrange
  const storage = memoryStorage();
  rememberColors(storage, "server-a", oceanPresentation(LATER));
  const stored = storage.getItem("factory.inherited-colors");
  assert(stored);
  storage.setItem(
    "factory.inherited-colors",
    stored.replace("#17212b", "url(https://example.invalid/x)"),
  );

  // Act
  const cached = cachedColors(storage, "server-a", NOW);

  // Assert
  expect(cached).toBe(null);
});

it("the server ending inheritance removes the cached theme colors", () => {
  // Arrange
  const storage = memoryStorage();
  rememberColors(storage, "server-a", oceanPresentation(LATER));

  // Act
  forgetColors(storage);

  // Assert
  expect(cachedColors(storage, "server-a", NOW)).toBe(null);
  expect(storage.items.size).toBe(0);
});

it("the cache keeps one snapshot with both modes and no per-mode entries", () => {
  // Arrange
  const storage = memoryStorage();

  // Act
  rememberColors(storage, "server-a", oceanPresentation(LATER));

  // Assert
  expect([...storage.items.keys()]).toStrictEqual(["factory.inherited-colors"]);
});

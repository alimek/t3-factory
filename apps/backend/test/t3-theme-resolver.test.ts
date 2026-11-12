import { assert, expect, it } from "@effect/vitest";
import { publishedThemes } from "../src/adapters/live-t3-appearance.ts";
import { T3_RESOLVER_PIN, resolveT3Theme } from "../src/appearance/t3-theme-palettes.ts";
import {
  upstreamBuiltIn,
  upstreamCanonicalColor,
  upstreamDroppedTheme,
  upstreamPin,
  upstreamPublishedPin,
  upstreamPublishedTheme,
} from "./support/t3-theme-fixture.ts";

/** A published definition without seeds whose own Dark colors are `colors`. */
const darkTheme = (colors: Record<string, string>) =>
  publishedThemes([{ id: "custom", name: "Custom", appearance: "dark", colors }]);

it("the resolver is pinned to the T3 revision its parity fixture came from", () => {
  // Arrange
  const fixturePins = [upstreamPin, upstreamPublishedPin];

  // Act
  const pin = T3_RESOLVER_PIN;

  // Assert
  expect(fixturePins).toStrictEqual([pin, pin]);
});

it("the T3 Chat built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("t3-chat");

  // Act
  const resolved = resolveT3Theme("t3-chat", []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: expected, unreadColors: 0 });
});

it("the Grove built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("grove");

  // Act
  const resolved = resolveT3Theme("grove", []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: expected, unreadColors: 0 });
});

it("the Ocean built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("ocean");

  // Act
  const resolved = resolveT3Theme("ocean", []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: expected, unreadColors: 0 });
});

it("the Ember built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("ember");

  // Act
  const resolved = resolveT3Theme("ember", []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: expected, unreadColors: 0 });
});

it("the Iris built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("iris");

  // Act
  const resolved = resolveT3Theme("iris", []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: expected, unreadColors: 0 });
});

it("a legacy built-in alias resolves to the built-in it names", () => {
  // Arrange
  const expected = upstreamBuiltIn("grove");

  // Act
  const resolved = resolveT3Theme("t3-grove", []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: expected, unreadColors: 0 });
});

it("a published theme absent from T3's set is reported as missing", () => {
  // Arrange
  const publishedId = "nightfall";

  // Act
  const resolved = resolveT3Theme(publishedId, []);

  // Assert
  expect(resolved).toStrictEqual({ kind: "missing" });
});

it("dark canvas and accent seeds generate the upstream palette and no Light colors", () => {
  // Arrange
  const { wire, id, modes } = upstreamPublishedTheme("seed-dark");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({
    kind: "theme",
    theme: { id, name: "Nightfall", modes },
    unreadColors: 0,
  });
  expect(modes.light).toBe(null);
});

it("light canvas and accent seeds generate the upstream palette and no Dark colors", () => {
  // Arrange
  const { wire, id, modes } = upstreamPublishedTheme("seed-light");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({
    kind: "theme",
    theme: { id, name: "Paper", modes },
    unreadColors: 0,
  });
  expect(modes.dark).toBe(null);
});

it("color overrides replace generated roles while an unknown role and an unreadable color are ignored", () => {
  // Arrange
  const { wire, id, modes } = upstreamPublishedTheme("seed-with-overrides");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({
    kind: "theme",
    theme: { id, name: "Nightfall tuned", modes },
    unreadColors: 1,
  });
});

it("a sparse Light variant of a dark seeded theme fills its other roles from T3 Chat, not the seeds", () => {
  // Arrange
  const { wire, id, modes } = upstreamPublishedTheme("seed-with-variant");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({
    kind: "theme",
    theme: { id, name: "Dusk", modes },
    unreadColors: 0,
  });
});

it("partial colors without seeds and a partial Dark variant resolve as upstream in both modes", () => {
  // Arrange
  const { wire, id, modes } = upstreamPublishedTheme("partial-overrides-with-variant");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({
    kind: "theme",
    theme: { id, name: "Harbor", modes },
    unreadColors: 0,
  });
});

it("a definition giving every role its own color resolves to those colors", () => {
  // Arrange
  const { wire, id, modes } = upstreamPublishedTheme("complete-colors");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({
    kind: "theme",
    theme: { id, name: "Exported", modes },
    unreadColors: 0,
  });
});

it("a published definition under a built-in id never replaces the built-in theme", () => {
  // Arrange
  const { wire, id } = upstreamDroppedTheme("reservedId");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({ kind: "theme", theme: upstreamBuiltIn(id), unreadColors: 0 });
});

it("a published definition without seeds or any color of a T3 role is not a theme", () => {
  // Arrange
  const { wire, id } = upstreamDroppedTheme("noUsableColors");

  // Act
  const resolved = resolveT3Theme(id, publishedThemes([wire]));

  // Assert
  expect(resolved).toStrictEqual({ kind: "unsupported", name: "Empty", reason: "no-colors" });
});

it("rgb(), oklch() and hex-with-alpha colors canonicalize to upstream's text", () => {
  // Arrange
  const published = darkTheme({
    canvas: "rgb(10 20 30)",
    accent: "oklch(0.62 0.2 280)",
    border: "#11223380",
    text: "#fff",
  });

  // Act
  const resolved = resolveT3Theme("custom", published);

  // Assert
  assert(resolved.kind === "theme");
  expect(resolved.theme.modes.dark).toMatchObject({
    canvas: upstreamCanonicalColor("rgb(10 20 30)"),
    accent: upstreamCanonicalColor("oklch(0.62 0.2 280)"),
    border: upstreamCanonicalColor("#11223380"),
    text: upstreamCanonicalColor("#fff"),
  });
});

it("a color value carrying a declaration or URL is dropped and counted, never passed on", () => {
  // Arrange
  const published = darkTheme({
    canvas: "#101418",
    accent: "red;background:url(https://example.test/x)",
    focus: "url(https://example.test/y)",
  });

  // Act
  const resolved = resolveT3Theme("custom", published);

  // Assert
  assert(resolved.kind === "theme");
  expect(resolved.unreadColors).toBe(2);
  expect(resolved.theme.modes.dark).toMatchObject({
    accent: upstreamBuiltIn("t3-chat").modes.dark?.accent,
    focus: upstreamBuiltIn("t3-chat").modes.dark?.focus,
  });
});

it("a definition in a newer theme file version is not resolved", () => {
  // Arrange
  const published = publishedThemes([
    {
      id: "future",
      name: "Future",
      version: 2,
      appearance: "dark",
      canvas: "#000",
      accent: "#fff",
    },
  ]);

  // Act
  const resolved = resolveT3Theme("future", published);

  // Assert
  expect(resolved).toStrictEqual({ kind: "unsupported", name: "Future", reason: "format" });
});

it("a definition whose seed is not a hex color is not resolved", () => {
  // Arrange
  const published = publishedThemes([
    { id: "odd", name: "Odd", appearance: "dark", canvas: "var(--x)", accent: "#fff" },
  ]);

  // Act
  const resolved = resolveT3Theme("odd", published);

  // Assert
  expect(resolved).toStrictEqual({ kind: "unsupported", name: "Odd", reason: "format" });
});

it("a definition whose colors are not a record of short strings is not resolved", () => {
  // Arrange
  const published = publishedThemes([
    { id: "odd", name: "Odd", appearance: "dark", colors: { canvas: { nested: "#000" } } },
  ]);

  // Act
  const resolved = resolveT3Theme("odd", published);

  // Assert
  expect(resolved).toStrictEqual({ kind: "unsupported", name: "Odd", reason: "format" });
});

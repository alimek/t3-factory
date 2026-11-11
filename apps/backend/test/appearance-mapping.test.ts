import { assert, expect, it } from "@effect/vitest";
import { presentThemeModes } from "../src/appearance/palette-mapping.ts";
import { resolveBuiltInTheme, type T3ThemePalette } from "../src/appearance/t3-theme-palettes.ts";
import { wcagContrast } from "./support/contrast.ts";

/** A dark palette whose roles are readable as given; cases replace the roles they test. */
const darkPalette: T3ThemePalette = {
  canvas: "#17212b",
  text: "#fffaff",
  textMuted: "#a4a4ac",
  placeholder: "#8d8f97",
  surfaceRaised: "#232d38",
  border: "#405567",
  input: "#4f677b",
  focus: "#70b9ee",
  accent: "#70b9ee",
  accentForeground: "#241523",
  sidebar: "#1e2d3b",
  sidebarForeground: "#fffaff",
};
const lightPalette: T3ThemePalette = { ...resolveBuiltInTheme("ocean")!.modes.light! };

it("a built-in palette maps T3 surfaces, text, accent and focus to Factory roles by meaning", () => {
  // Arrange
  const ocean = resolveBuiltInTheme("ocean")!;

  // Act
  const modes = presentThemeModes(ocean);

  // Assert
  assert(modes.light.kind === "inherited");
  expect(modes.light.colors.background).toBe("#f5f7f8");
  expect(modes.light.colors.foreground).toBe("#241523");
  expect(modes.light.colors.card).toBe("#edeff1");
  expect(modes.light.colors.sidebar).toBe("#e4ecf2");
  expect(modes.light.colors.primary).toBe("#2672af");
  expect(modes.light.colors.ring).toBe("#2672af");
  expect(modes.light.colors.accent).not.toBe(modes.light.colors.primary);
  expect(modes.light.colors["sidebar-accent"]).not.toBe(modes.light.colors.primary);
});

it("a Factory status color too dim for the inherited canvas is adjusted until readable", () => {
  // Arrange
  const dimCanvas = {
    id: "dim",
    name: "Dim",
    modes: {
      light: null,
      dark: { ...darkPalette, canvas: "#4a4e57", surfaceRaised: "#4a4e57", sidebar: "#4a4e57" },
    },
  };

  // Act
  const modes = presentThemeModes(dimCanvas);

  // Assert
  assert(modes.dark.kind === "inherited");
  expect(wcagContrast(modes.dark.colors["status-waiting"], "#4a4e57")).toBeGreaterThanOrEqual(4.5);
});

it("a mode whose text cannot be readable on every surface uses Factory's colors for that mode only", () => {
  // Arrange
  const splitSurfaces = {
    id: "split",
    name: "Split",
    modes: { light: lightPalette, dark: { ...darkPalette, surfaceRaised: "#f0f0f0" } },
  };

  // Act
  const modes = presentThemeModes(splitSurfaces);

  // Assert
  expect(modes.dark.kind).toBe("baseline");
  expect(modes.light.kind).toBe("inherited");
});

it("a theme without colors for a mode uses Factory's colors for that mode only", () => {
  // Arrange
  const lightOnly = {
    id: "light-only",
    name: "Light only",
    modes: { light: lightPalette, dark: null },
  };

  // Act
  const modes = presentThemeModes(lightOnly);

  // Assert
  expect(modes.dark.kind).toBe("baseline");
  expect(modes.light.kind).toBe("inherited");
});

it("a dark mode whose canvas is light is not presented as Dark", () => {
  // Arrange
  const inverted = {
    id: "inverted",
    name: "Inverted",
    modes: { light: null, dark: { ...lightPalette } },
  };

  // Act
  const modes = presentThemeModes(inverted);

  // Assert
  expect(modes.dark.kind).toBe("baseline");
});

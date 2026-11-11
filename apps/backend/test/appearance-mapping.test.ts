import { assert, expect, it } from "@effect/vitest";
import { presentThemeModes } from "../src/appearance/palette-mapping.ts";
import { resolveT3Theme, type T3ThemePalette } from "../src/appearance/t3-theme-palettes.ts";
import { wcagContrast } from "./support/contrast.ts";

/** T3's built-in Ocean theme as the pinned resolver reads it. */
function builtInOcean() {
  const lookup = resolveT3Theme("ocean", []);
  assert(lookup.kind === "theme");
  return lookup.theme;
}

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
const lightPalette: T3ThemePalette = { ...builtInOcean().modes.light! };

it("a built-in palette maps T3 surfaces, text, accent and focus to Factory roles by meaning", () => {
  // Arrange
  const ocean = builtInOcean();

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

it.each(["t3-chat", "grove", "ocean", "ember", "iris"])(
  "secondary text of built-in %s stays readable on hovered rows, the sidebar and its selected rows",
  (id) => {
    // Arrange
    const lookup = resolveT3Theme(id, []);
    assert(lookup.kind === "theme");

    // Act
    const modes = presentThemeModes(lookup.theme);

    // Assert
    for (const mode of [modes.light, modes.dark]) {
      assert(mode.kind === "inherited");
      const surfaces = ["background", "card", "muted", "accent", "sidebar", "sidebar-accent"];
      const ratios = surfaces.map((surface) =>
        wcagContrast(mode.colors["muted-foreground"], mode.colors[surface as "accent"]),
      );
      expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
    }
  },
);

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

it("an accent whose dark action label would be unreadable on a darker hover fill lightens on hover instead", () => {
  // Arrange
  const vividAccent = {
    id: "vivid",
    name: "Vivid",
    modes: {
      light: null,
      dark: { ...darkPalette, accent: "#7c5cff", focus: "#7c5cff", accentForeground: "#000000" },
    },
  };

  // Act
  const modes = presentThemeModes(vividAccent);

  // Assert
  assert(modes.dark.kind === "inherited");
  expect(modes.dark.colors.primary).toBe("#7c5cff");
  expect(
    wcagContrast(modes.dark.colors["primary-foreground"], modes.dark.colors["primary-hover"]),
  ).toBeGreaterThanOrEqual(4.5);
});

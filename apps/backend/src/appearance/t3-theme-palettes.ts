/*!
 * Built-in T3 theme palettes and the resolution of built-in and published themes, ported from
 * T3 Code (https://github.com/pingdotgg/t3code) at revision
 * d2c25950b4d9183ea342d5d5fc14c326b9e0172a: the color values, role names and reserved ids of
 * packages/shared/src/themePalettes.ts and the per-mode, legacy-alias and published-definition
 * resolution of apps/web/src/themePalette.ts (`publishedThemeDefinitions`,
 * `getThemeColorsForMode`), limited to the roles Factory maps.
 *
 * @license MIT
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Appearance } from "@t3-factory/contracts/desktop-bridge";
import type { PublishedT3Theme, T3ThemeColors } from "../adapters/t3.ts";
import { canonicalThemeColor, generateSeedColors } from "./t3-theme-generator.ts";

/** The T3 revision these palettes and their resolution were inspected and ported from. */
export const T3_RESOLVER_PIN = "d2c25950b4d9183ea342d5d5fc14c326b9e0172a";

/** The T3 color roles Factory maps; T3 defines more, which Factory never reads. */
export const T3_THEME_ROLES = [
  "canvas",
  "text",
  "textMuted",
  "placeholder",
  "surfaceRaised",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "sidebar",
  "sidebarForeground",
] as const;
export type T3ThemePalette = Readonly<Record<(typeof T3_THEME_ROLES)[number], string>>;

/** Every role name T3 defines; a published color under any other name is not a color of T3's. */
const T3_ROLE_NAMES: ReadonlySet<string> = new Set([
  ...T3_THEME_ROLES,
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceOverlay",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "searchMatchBackground",
  "searchMatchForeground",
  "searchMatchActiveBackground",
  "searchMatchActiveForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
]);

/** One theme as T3 resolves it; a mode is null when the theme has no colors for it. */
export interface T3Theme {
  readonly id: string;
  readonly name: string;
  readonly modes: Readonly<Record<Appearance, T3ThemePalette | null>>;
}

type BuiltInTheme = { readonly name: string } & Readonly<Record<Appearance, T3ThemePalette>>;

// Every built-in is authored for Light with a Dark variant, so both modes resolve.
const BUILT_IN_THEMES: Readonly<Record<string, BuiltInTheme>> = {
  "t3-chat": {
    name: "T3 Chat",
    light: {
      canvas: "oklch(0.982446 0.010114 325.653)",
      text: "oklch(0.325698 0.116116 325.037)",
      textMuted: "oklch(0.494754 0.190937 354.544)",
      placeholder: "oklch(0.549927 0.090215 323.149)",
      surfaceRaised: "oklch(0.988235 0.005049 325.615)",
      border: "oklch(0.923531 0.021247 328.096)",
      input: "oklch(0.851713 0.055822 336.6)",
      focus: "oklch(0.591646 0.217985 0.584)",
      accent: "oklch(0.591646 0.217985 0.584)",
      accentForeground: "oklch(1 0 0)",
      sidebar: "oklch(0.928886 0.031178 322.592)",
      sidebarForeground: "oklch(0.396296 0.025134 285.196)",
    },
    dark: {
      canvas: "oklch(0.22813 0.020366 307.469)",
      text: "oklch(0.980735 0.004092 301.426)",
      textMuted: "oklch(0.880303 0.03077 342.696)",
      placeholder: "oklch(0.657087 0.028226 307.985)",
      surfaceRaised: "oklch(0.279864 0.021572 309.532)",
      border: "oklch(0.266943 0.015262 302.425)",
      input: "oklch(0.266817 0.02897 344.461)",
      focus: "oklch(0.591646 0.217985 0.584)",
      accent: "oklch(0.460685 0.185347 4.099)",
      accentForeground: "oklch(0.901233 0.057189 343.694)",
      sidebar: "oklch(0.185778 0.019368 322.159)",
      sidebarForeground: "oklch(0.967434 0.001326 286.375)",
    },
  },
  grove: {
    name: "Grove",
    light: {
      canvas: "oklch(0.972369 0.005497 157.15)",
      text: "oklch(0.222003 0.03479 328.979)",
      textMuted: "oklch(0.540472 0.014944 326.176)",
      placeholder: "oklch(0.529681 0.01551 326.299)",
      surfaceRaised: "oklch(0.949276 0.004496 159.002)",
      border: "oklch(0.864831 0.01312 167.255)",
      input: "oklch(0.829746 0.016084 168.234)",
      focus: "oklch(0.523295 0.112292 158.089)",
      accent: "oklch(0.523295 0.112292 158.089)",
      accentForeground: "oklch(0.990339 0.008411 325.64)",
      sidebar: "oklch(0.936464 0.014601 163.554)",
      sidebarForeground: "oklch(0.222003 0.03479 328.979)",
    },
    dark: {
      canvas: "oklch(0.260865 0.02152 162.75)",
      text: "oklch(0.990339 0.008411 325.64)",
      textMuted: "oklch(0.666747 0.004239 187.292)",
      placeholder: "oklch(0.739243 0.002222 223.225)",
      surfaceRaised: "oklch(0.363192 0.016572 165.32)",
      border: "oklch(0.457475 0.044046 160.971)",
      input: "oklch(0.519849 0.049896 160.863)",
      focus: "oklch(0.796228 0.133058 157.319)",
      accent: "oklch(0.796228 0.133058 157.319)",
      accentForeground: "oklch(0.222003 0.03479 328.979)",
      sidebar: "oklch(0.309925 0.032827 160.944)",
      sidebarForeground: "oklch(0.990339 0.008411 325.64)",
    },
  },
  ocean: {
    name: "Ocean",
    light: {
      canvas: "oklch(0.974199 0.002856 241.597)",
      text: "oklch(0.222003 0.03479 328.979)",
      textMuted: "oklch(0.541555 0.017468 323.531)",
      placeholder: "oklch(0.530733 0.01795 323.79)",
      surfaceRaised: "oklch(0.951058 0.002962 258.339)",
      border: "oklch(0.867646 0.013482 252.362)",
      input: "oklch(0.832939 0.017389 252.598)",
      focus: "oklch(0.536684 0.120219 247.01)",
      accent: "oklch(0.536684 0.120219 247.01)",
      accentForeground: "oklch(0.990339 0.008411 325.64)",
      sidebar: "oklch(0.939254 0.01193 241.729)",
      sidebarForeground: "oklch(0.222003 0.03479 328.979)",
    },
    dark: {
      canvas: "oklch(0.242641 0.024125 250.573)",
      text: "oklch(0.990339 0.008411 325.64)",
      textMuted: "oklch(0.652227 0.01149 273.31)",
      placeholder: "oklch(0.721641 0.010192 281.271)",
      surfaceRaised: "oklch(0.348439 0.019942 253.696)",
      border: "oklch(0.438653 0.039496 245.44)",
      input: "oklch(0.500905 0.043574 244.781)",
      focus: "oklch(0.758933 0.105833 241.548)",
      accent: "oklch(0.758933 0.105833 241.548)",
      accentForeground: "oklch(0.222003 0.03479 328.979)",
      sidebar: "oklch(0.290387 0.032043 247.274)",
      sidebarForeground: "oklch(0.990339 0.008411 325.64)",
    },
  },
  ember: {
    name: "Ember",
    light: {
      canvas: "oklch(0.976527 0.002685 60.725)",
      text: "oklch(0.222003 0.03479 328.979)",
      textMuted: "oklch(0.543023 0.017316 331.964)",
      placeholder: "oklch(0.532339 0.017796 331.748)",
      surfaceRaised: "oklch(0.953321 0.002701 42.266)",
      border: "oklch(0.870631 0.013204 39.431)",
      input: "oklch(0.836213 0.017153 38.661)",
      focus: "oklch(0.552831 0.129438 44.656)",
      accent: "oklch(0.552831 0.129438 44.656)",
      accentForeground: "oklch(0.990339 0.008411 325.64)",
      sidebar: "oklch(0.942267 0.01151 50.785)",
      sidebarForeground: "oklch(0.222003 0.03479 328.979)",
    },
    dark: {
      canvas: "oklch(0.245899 0.019144 42.044)",
      text: "oklch(0.990339 0.008411 325.64)",
      textMuted: "oklch(0.654017 0.009505 13.287)",
      placeholder: "oklch(0.723533 0.008741 4.515)",
      surfaceRaised: "oklch(0.351262 0.01565 37.592)",
      border: "oklch(0.44099 0.040202 48.807)",
      input: "oklch(0.503003 0.045721 49.44)",
      focus: "oklch(0.762174 0.124117 52.082)",
      accent: "oklch(0.762174 0.124117 52.082)",
      accentForeground: "oklch(0.222003 0.03479 328.979)",
      sidebar: "oklch(0.293349 0.029554 46.882)",
      sidebarForeground: "oklch(0.990339 0.008411 325.64)",
    },
  },
  iris: {
    name: "Iris",
    light: {
      canvas: "oklch(0.976531 0.003855 303.226)",
      text: "oklch(0.222003 0.03479 328.979)",
      textMuted: "oklch(0.543042 0.018894 325.652)",
      placeholder: "oklch(0.532177 0.019333 325.784)",
      surfaceRaised: "oklch(0.953326 0.004536 307.676)",
      border: "oklch(0.869608 0.018226 303.859)",
      input: "oklch(0.834773 0.023405 303.676)",
      focus: "oklch(0.525348 0.15373 294.176)",
      accent: "oklch(0.525348 0.15373 294.176)",
      accentForeground: "oklch(0.990339 0.008411 325.64)",
      sidebar: "oklch(0.941387 0.014687 300.474)",
      sidebarForeground: "oklch(0.222003 0.03479 328.979)",
    },
    dark: {
      canvas: "oklch(0.225975 0.031062 293.741)",
      text: "oklch(0.990339 0.008411 325.64)",
      textMuted: "oklch(0.640465 0.016197 304.171)",
      placeholder: "oklch(0.706249 0.014508 306.607)",
      surfaceRaised: "oklch(0.335291 0.026008 296.394)",
      border: "oklch(0.40874 0.058536 295.893)",
      input: "oklch(0.46756 0.065775 296.265)",
      focus: "oklch(0.671712 0.169136 293.929)",
      accent: "oklch(0.671712 0.169136 293.929)",
      accentForeground: "oklch(0.222003 0.03479 328.979)",
      sidebar: "oklch(0.266743 0.044689 294.138)",
      sidebarForeground: "oklch(0.990339 0.008411 325.64)",
    },
  },
};

/** Ids earlier T3 versions stored; T3 still reads them as the built-in they name. */
const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  "t3-chat-dark": "t3-chat",
  "t3-grove": "grove",
  "t3-ocean": "ocean",
  "t3-ember": "ember",
  "t3-iris": "iris",
};

/** The built-in theme an environment default names, or null for any other id. */
function resolveBuiltInTheme(themeId: string): T3Theme | null {
  const id = LEGACY_ALIASES[themeId] ?? themeId;
  const theme = Object.hasOwn(BUILT_IN_THEMES, id) ? BUILT_IN_THEMES[id] : undefined;
  if (!theme) return null;
  return { id, name: theme.name, modes: { light: theme.light, dark: theme.dark } };
}

/** T3's appearance keywords: never a theme, whatever a published definition is called. */
const APPEARANCE_KEYWORDS: ReadonlySet<string> = new Set(["system", "light", "dark"]);

/** What T3's environment default theme id resolves to. */
export type T3ThemeLookup =
  | {
      readonly kind: "theme";
      readonly theme: T3Theme;
      /** Colors given for roles Factory maps that it could not read and so left at their base. */
      readonly unreadColors: number;
    }
  /** Neither a built-in theme nor in the published set. */
  | { readonly kind: "missing" }
  | {
      readonly kind: "unsupported";
      readonly name: string;
      /** Not T3's theme file version 1, or no seeds and no color Factory can read. */
      readonly reason: "format" | "no-colors";
    };

/**
 * The colors a published definition gives the roles T3 defines, as upstream's lenient overrides:
 * unknown roles and colors that cannot be read are dropped, never an error.
 */
function readColors(colors: T3ThemeColors) {
  const read: Partial<Record<string, string>> = {};
  let unread = 0;
  for (const [role, color] of Object.entries(colors)) {
    if (!T3_ROLE_NAMES.has(role)) continue;
    const canonical = canonicalThemeColor(color);
    if (canonical) read[role] = canonical;
    else if ((T3_THEME_ROLES as readonly string[]).includes(role)) unread++;
  }
  return { read, unread, usable: Object.keys(read).length > 0 };
}

const withOverrides = (base: T3ThemePalette, overrides: Partial<Record<string, string>>) =>
  Object.fromEntries(
    T3_THEME_ROLES.map((role) => [role, overrides[role] ?? base[role]]),
  ) as T3ThemePalette;

/**
 * A published theme as T3 resolves it. Its own appearance starts from the palette generated
 * from its seeds, or from T3 Chat's without seeds, and takes its `colors` on top. The other
 * mode exists only when the definition declares a variant for it: T3 Chat's palette for that
 * mode with the variant's colors on top, never the seeds.
 */
function resolvePublishedTheme({ id, name, definition }: PublishedT3Theme): T3ThemeLookup {
  if (!definition) return { kind: "unsupported", name, reason: "format" };
  const { appearance, seeds } = definition;
  const other = appearance === "dark" ? "light" : "dark";
  const colors = readColors(definition.colors);
  const variant = definition.variant && readColors(definition.variant);
  if (!seeds && !colors.usable && !variant?.usable)
    return { kind: "unsupported", name, reason: "no-colors" };
  const defaults = BUILT_IN_THEMES["t3-chat"]!;
  const base = seeds ? generateSeedColors(seeds.canvas, seeds.accent) : defaults[appearance];
  const modes = {
    [appearance]: withOverrides(base, colors.read),
    [other]: variant ? withOverrides(defaults[other], variant.read) : null,
  } as Record<Appearance, T3ThemePalette | null>;
  return {
    kind: "theme",
    theme: { id, name, modes: { light: modes.light, dark: modes.dark } },
    unreadColors: colors.unread + (variant?.unread ?? 0),
  };
}

/**
 * Resolves the environment default theme id against T3's built-in themes and the published
 * set, in T3's order: a built-in id or legacy alias always names the built-in, and appearance
 * keywords name no theme.
 */
export function resolveT3Theme(
  themeId: string,
  published: readonly PublishedT3Theme[],
): T3ThemeLookup {
  const builtIn = resolveBuiltInTheme(themeId);
  if (builtIn) return { kind: "theme", theme: builtIn, unreadColors: 0 };
  const theme = APPEARANCE_KEYWORDS.has(themeId)
    ? undefined
    : published.find((candidate) => candidate.id === themeId);
  return theme ? resolvePublishedTheme(theme) : { kind: "missing" };
}

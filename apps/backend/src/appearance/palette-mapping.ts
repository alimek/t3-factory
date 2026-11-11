import type { AppearanceColorToken, AppearanceModeResult } from "@t3-factory/contracts";
import type { Appearance } from "@t3-factory/contracts/desktop-bridge";
import {
  contrast,
  formatHex,
  formatTranslucent,
  luminance,
  mix,
  parseColor,
  toOklch,
  toRgb,
  type Oklch,
  type Rgb,
} from "./color.ts";
import type { T3Theme, T3ThemePalette } from "./t3-theme-palettes.ts";

/**
 * Factory's own status and cyan colors per mode, as in apps/frontend/src/styles.css. Inherited
 * palettes keep these hue families and only move their lightness until they are readable.
 */
const FACTORY_STATUS: Readonly<Record<Appearance, Readonly<Record<StatusToken, string>>>> = {
  dark: {
    destructive: "#ef4444",
    success: "#22c55e",
    attention: "#f59e0b",
    "status-working": "#22d3ee",
    "status-waiting": "#818cf8",
    "status-stopped": "#a1a1aa",
    "brand-cyan": "#22d3ee",
  },
  light: {
    destructive: "#dc2626",
    success: "#15803d",
    attention: "#b45309",
    "status-working": "#0e7490",
    "status-waiting": "#4f46e5",
    "status-stopped": "#71717a",
    "brand-cyan": "#0e7490",
  },
};
type StatusToken =
  | "destructive"
  | "success"
  | "attention"
  | "status-working"
  | "status-waiting"
  | "status-stopped"
  | "brand-cyan";

/** WCAG AA for text, and for focus indicators against what they surround. */
const TEXT_CONTRAST = 4.5;
const NON_TEXT_CONTRAST = 3;

/**
 * Lightness steps of Factory's derived neutral fills, as its baselines step them: toward white
 * in Dark and toward black in Light. They keep the base surface's own hue and chroma, so hover
 * and selection never take T3's accent color.
 */
const NEUTRAL_STEP = { muted: [0.04, -0.035], hover: [0.08, -0.06], selected: [0.06, -0.05] };

/** The extremes a label can be moved to: black and white. */
const INKS: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 1, g: 1, b: 1 },
];

const modeLabel = (mode: Appearance) => (mode === "dark" ? "Dark" : "Light");

/** Rejection carries the readable reason a whole mode falls back to Factory's colors. */
class Unreadable extends Error {}

/**
 * The color closest to `color` in lightness that reaches `minimum` contrast with every surface,
 * moving toward whichever of black or white can reach it. Fails when neither can.
 */
function readable(color: Oklch, surfaces: readonly Rgb[], minimum: number, what: string): Rgb {
  const worst = (candidate: Rgb) =>
    Math.min(...surfaces.map((surface) => contrast(candidate, surface)));
  if (worst(toRgb(color)) >= minimum) return toRgb(color);
  const extreme = [1, 0]
    .map((l) => ({ l, score: worst(toRgb({ ...color, l })) }))
    .sort((a, b) => b.score - a.score)[0]!;
  if (extreme.score < minimum) throw new Unreadable(`${what} that cannot be made readable`);
  let [near, far] = [color.l, extreme.l];
  for (let step = 0; step < 20; step++) {
    const l = (near + far) / 2;
    if (worst(toRgb({ ...color, l })) >= minimum) far = l;
    else near = l;
  }
  return toRgb({ ...color, l: far });
}

function parsePalette(palette: T3ThemePalette) {
  const parsed: Partial<Record<keyof T3ThemePalette, Oklch>> = {};
  for (const [role, value] of Object.entries(palette) as [keyof T3ThemePalette, string][]) {
    const color = parseColor(value);
    if (!color) throw new Unreadable("colors Factory cannot read");
    parsed[role] = color;
  }
  return parsed as Record<keyof T3ThemePalette, Oklch>;
}

/** A Dark palette must have a dark canvas and a Light one a light canvas. */
function readsAs(mode: Appearance, canvas: Rgb) {
  return mode === "dark" ? luminance(canvas) <= 0.2 : luminance(canvas) >= 0.4;
}

function mapMode(palette: T3ThemePalette, mode: Appearance) {
  const t3 = parsePalette(palette);
  const step = (base: Oklch, [dark, light]: number[]) =>
    toRgb({ ...base, l: base.l + (mode === "dark" ? dark! : light!) });
  const background = toRgb(t3.canvas);
  if (!readsAs(mode, background))
    throw new Unreadable(`a canvas that does not read as ${modeLabel(mode)}`);
  const card = toRgb(t3.surfaceRaised);
  const muted = step(t3.canvas, NEUTRAL_STEP.muted);
  const hover = step(t3.canvas, NEUTRAL_STEP.hover);
  const sidebar = toRgb(t3.sidebar);
  const selected = step(t3.sidebar, NEUTRAL_STEP.selected);
  const primary = toRgb(t3.accent);
  // The action fill darkens on hover as the baselines do. Where no label could stay readable
  // on both fills, the accent takes a dark label, and the hover fill lightens instead.
  const actionHover = (step: number) => toRgb({ ...t3.accent, l: t3.accent.l + step });
  const primaryHover = INKS.some((ink) =>
    [primary, actionHover(-0.06)].every((fill) => contrast(ink, fill) >= TEXT_CONTRAST),
  )
    ? actionHover(-0.06)
    : actionHover(0.06);
  const surfaces = [background, card, muted];

  const foreground = readable(t3.text, [...surfaces, hover], TEXT_CONTRAST, "text");
  // Secondary text also sits on hovered rows and on the sidebar and its selected rows.
  const mutedForeground = readable(
    t3.textMuted,
    [...surfaces, hover, sidebar, selected],
    TEXT_CONTRAST,
    "secondary text",
  );
  const emphasis = readable(
    toOklch(mix(foreground, mutedForeground, 0.5)),
    surfaces,
    TEXT_CONTRAST,
    "emphasized text",
  );
  const sidebarForeground = readable(
    t3.sidebarForeground,
    [sidebar, selected],
    TEXT_CONTRAST,
    "sidebar text",
  );
  const ring = readable(t3.focus, [background, card, sidebar], NON_TEXT_CONTRAST, "focus");
  const border = toRgb(t3.border);
  const statusSurfaces = [...surfaces, sidebar];
  const status = Object.fromEntries(
    Object.entries(FACTORY_STATUS[mode]).map(([token, value]) => [
      token,
      formatHex(readable(parseColor(value)!, statusSurfaces, TEXT_CONTRAST, `${token} status`)),
    ]),
  ) as Record<StatusToken, string>;

  const colors: Record<AppearanceColorToken, string> = {
    background: formatHex(background),
    foreground: formatHex(foreground),
    card: formatHex(card),
    "card-foreground": formatHex(foreground),
    popover: formatHex(card),
    "popover-foreground": formatHex(foreground),
    muted: formatHex(muted),
    "muted-foreground": formatHex(mutedForeground),
    "subtle-foreground": formatHex(
      readable(t3.placeholder, surfaces, NON_TEXT_CONTRAST, "section labels"),
    ),
    "emphasis-foreground": formatHex(emphasis),
    accent: formatHex(hover),
    "accent-foreground": formatHex(foreground),
    secondary: formatHex(hover),
    "secondary-foreground": formatHex(foreground),
    sidebar: formatHex(sidebar),
    "sidebar-foreground": formatHex(sidebarForeground),
    "sidebar-accent": formatHex(selected),
    "sidebar-accent-foreground": formatHex(sidebarForeground),
    "sidebar-border": formatHex(border),
    "sidebar-ring": formatHex(ring),
    primary: formatHex(primary),
    "primary-hover": formatHex(primaryHover),
    "primary-foreground": formatHex(
      readable(t3.accentForeground, [primary, primaryHover], TEXT_CONTRAST, "action labels"),
    ),
    "brand-soft": formatTranslucent(primary, mode === "dark" ? 0.14 : 0.08),
    "brand-soft-border": formatTranslucent(primary, mode === "dark" ? 0.6 : 0.45),
    link: formatHex(readable(t3.accent, surfaces, TEXT_CONTRAST, "links")),
    border: formatHex(border),
    "border-strong": formatHex(mix(border, foreground, 0.12)),
    "border-hover": formatHex(mix(border, foreground, 0.22)),
    input: formatHex(toRgb(t3.input)),
    ring: formatHex(ring),
    overlay:
      mode === "dark" ? formatTranslucent(background, 0.8) : formatTranslucent(foreground, 0.28),
    ...status,
  };
  return colors;
}

function presentMode(theme: T3Theme, mode: Appearance): AppearanceModeResult {
  const palette = theme.modes[mode];
  const fallback = `Factory’s ${modeLabel(mode)} colors are used.`;
  if (!palette)
    return {
      kind: "baseline",
      explanation: `T3 theme “${theme.name}” has no ${modeLabel(mode)} colors. ${fallback}`,
    };
  try {
    return { kind: "inherited", colors: mapMode(palette, mode) };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return {
      kind: "baseline",
      explanation: `T3 theme “${theme.name}” has ${modeLabel(mode)} colors with ${error.message}. ${fallback}`,
    };
  }
}

/**
 * Maps both modes of a T3 theme onto Factory's color tokens by meaning. Each mode is validated
 * on its own: a mode whose required text, focus or action colors cannot be made readable falls
 * back to Factory's baseline for that mode, never to partially inherited colors.
 */
export function presentThemeModes(theme: T3Theme): Record<Appearance, AppearanceModeResult> {
  return { light: presentMode(theme, "light"), dark: presentMode(theme, "dark") };
}

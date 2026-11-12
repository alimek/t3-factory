import { readFileSync } from "node:fs";
import { T3_THEME_ROLES } from "../../src/appearance/t3-theme-palettes.ts";

type UpstreamMode = Readonly<Record<string, string>> | null;
type UpstreamModes = { readonly light: UpstreamMode; readonly dark: UpstreamMode };
interface UpstreamFixture {
  readonly pinCommit: string;
  readonly themes: Readonly<Record<string, { readonly label: string } & UpstreamModes>>;
}
interface UpstreamPublishedFixture {
  readonly pinCommit: string;
  readonly themes: Readonly<
    Record<string, { readonly input: { readonly id: string }; readonly resolved: UpstreamModes }>
  >;
  readonly filtered: Readonly<Record<string, { readonly id: string }>>;
  readonly canonicalColors: Readonly<Record<string, string | null>>;
}

const fixture = <Fixture>(name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as Fixture;

/** What the upstream resolver produced at the pin; see fixtures/README.md. */
const upstream = fixture<UpstreamFixture>("t3-builtin-themes.json");
const upstreamPublished = fixture<UpstreamPublishedFixture>("t3-published-themes.json");

export const upstreamPin = upstream.pinCommit;
export const upstreamPublishedPin = upstreamPublished.pinCommit;

const roles = (colors: UpstreamMode) =>
  colors && Object.fromEntries(T3_THEME_ROLES.map((role) => [role, colors[role]]));
const modes = (resolved: UpstreamModes) => ({
  light: roles(resolved.light),
  dark: roles(resolved.dark),
});

/** The upstream colors of every role Factory reads, for both modes of one built-in theme. */
export function upstreamBuiltIn(id: string) {
  const theme = upstream.themes[id]!;
  return { id, name: theme.label, modes: modes(theme) };
}

export type UpstreamPublishedCase =
  | "seed-dark"
  | "seed-light"
  | "seed-with-overrides"
  | "seed-with-variant"
  | "partial-overrides-with-variant"
  | "complete-colors";

/**
 * One published definition exactly as T3 streams it, and the colors upstream resolved for the
 * roles Factory reads in both modes (null where upstream has no colors for a mode).
 */
export function upstreamPublishedTheme(name: UpstreamPublishedCase) {
  const theme = upstreamPublished.themes[name]!;
  return { wire: theme.input, id: theme.input.id, modes: modes(theme.resolved) };
}

/** A definition upstream drops: one under a reserved id, one without any usable color. */
export function upstreamDroppedTheme(name: "reservedId" | "noUsableColors") {
  const wire = upstreamPublished.filtered[name]!;
  return { wire, id: wire.id };
}

/** Upstream's canonical text for one color it was given, or null where it reads none. */
export const upstreamCanonicalColor = (input: string) => upstreamPublished.canonicalColors[input];

import { readFileSync } from "node:fs";
import { T3_THEME_ROLES } from "../../src/appearance/t3-theme-palettes.ts";

type UpstreamMode = Readonly<Record<string, string>> | null;
interface UpstreamFixture {
  readonly pinCommit: string;
  readonly themes: Readonly<
    Record<
      string,
      { readonly label: string; readonly light: UpstreamMode; readonly dark: UpstreamMode }
    >
  >;
}

/** Built-in palettes the upstream resolver produced at the pin; see fixtures/README.md. */
const upstream = JSON.parse(
  readFileSync(new URL("../fixtures/t3-builtin-themes.json", import.meta.url), "utf8"),
) as UpstreamFixture;

export const upstreamPin = upstream.pinCommit;

const roles = (colors: UpstreamMode) =>
  colors && Object.fromEntries(T3_THEME_ROLES.map((role) => [role, colors[role]]));

/** The upstream colors of every role Factory reads, for both modes of one built-in theme. */
export function upstreamBuiltIn(id: string) {
  const theme = upstream.themes[id]!;
  return {
    id,
    name: theme.label,
    modes: { light: roles(theme.light), dark: roles(theme.dark) },
  };
}

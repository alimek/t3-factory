import {
  APPEARANCE_COLOR_TOKENS,
  type AppearanceColorToken,
  type AppearanceModeResult,
  type AppearancePresentation,
} from "@t3-factory/contracts";

/** Factory's two output formats for an inherited color; nothing else is ever applied. */
const COLOR = /^(#[0-9a-f]{6}|rgb\(\d{1,3} \d{1,3} \d{1,3} \/ (0|1|0?\.\d{1,6})\))$/;
const TEXT_LIMIT = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= TEXT_LIMIT;

function parseMode(value: unknown): AppearanceModeResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === "baseline")
    return isText(value.explanation) ? { kind: "baseline", explanation: value.explanation } : null;
  if (value.kind !== "inherited" || !isRecord(value.colors)) return null;
  const colors: Partial<Record<AppearanceColorToken, string>> = {};
  for (const token of APPEARANCE_COLOR_TOKENS) {
    const color = value.colors[token];
    if (typeof color !== "string" || !COLOR.test(color)) return null;
    colors[token] = color;
  }
  return { kind: "inherited", colors: colors as Record<AppearanceColorToken, string> };
}

/**
 * A stored presentation snapshot read back from a cache (browser storage, the backend's
 * database). Storage is outside Factory's control, so the snapshot is rebuilt from exactly the
 * known fields and color formats; anything else makes the whole snapshot unusable.
 */
export function parseAppearancePresentation(value: unknown): AppearancePresentation | null {
  if (!isRecord(value) || !isRecord(value.grant) || !isRecord(value.theme)) return null;
  if (!isRecord(value.modes)) return null;
  const { revision, environmentId, resolverPin, grant, theme } = value;
  const light = parseMode(value.modes.light);
  const dark = parseMode(value.modes.dark);
  if (
    !isText(revision) ||
    !isText(environmentId) ||
    !isText(resolverPin) ||
    !isText(grant.id) ||
    !isText(grant.expiresAt) ||
    Number.isNaN(Date.parse(grant.expiresAt)) ||
    !isText(theme.id) ||
    !isText(theme.name) ||
    !light ||
    !dark
  )
    return null;
  return {
    revision,
    environmentId,
    grant: { id: grant.id, expiresAt: grant.expiresAt },
    resolverPin,
    theme: { id: theme.id, name: theme.name },
    modes: { light, dark },
  };
}

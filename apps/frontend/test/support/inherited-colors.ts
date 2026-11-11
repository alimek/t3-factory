import {
  APPEARANCE_COLOR_TOKENS,
  type AppearanceColorToken,
  type AppearancePresentation,
} from "@t3-factory/contracts";

/** One browser profile's storage for one Factory origin. */
export function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    /** What the profile holds, as a person inspecting or editing the storage sees it. */
    items,
  };
}

const colors = Object.fromEntries(
  APPEARANCE_COLOR_TOKENS.map((token) => [token, "#17212b"]),
) as Record<AppearanceColorToken, string>;

/** Ocean as a server published it: Dark inherited, Light on Factory's baseline. */
export function oceanPresentation(expiresAt: string): AppearancePresentation {
  return {
    revision: "ocean-revision",
    environmentId: "environment-1",
    grant: { id: "grant-1", expiresAt },
    resolverPin: "d2c25950b4d9183ea342d5d5fc14c326b9e0172a",
    theme: { id: "ocean", name: "Ocean" },
    modes: {
      dark: { kind: "inherited", colors },
      light: { kind: "baseline", explanation: "Ocean has no readable Light palette." },
    },
  };
}

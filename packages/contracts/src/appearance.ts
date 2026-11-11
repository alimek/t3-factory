import type { Appearance } from "./desktop-bridge.ts";
import { operation } from "./operation.ts";

/**
 * Every color token of Factory's design system, by its CSS custom property name without `--`.
 * An inherited mode replaces all of them at once, so a mode never mixes inherited and baseline
 * colors.
 */
export const APPEARANCE_COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "subtle-foreground",
  "emphasis-foreground",
  "accent",
  "accent-foreground",
  "secondary",
  "secondary-foreground",
  "sidebar",
  "sidebar-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "primary",
  "primary-hover",
  "primary-foreground",
  "brand-soft",
  "brand-soft-border",
  "link",
  "brand-cyan",
  "border",
  "border-strong",
  "border-hover",
  "input",
  "ring",
  "overlay",
  "destructive",
  "success",
  "attention",
  "status-working",
  "status-waiting",
  "status-stopped",
] as const;
export type AppearanceColorToken = (typeof APPEARANCE_COLOR_TOKENS)[number];

/**
 * One mode of an inherited palette. `inherited` colors are Factory-formatted `#rrggbb` or
 * `rgb(r g b / a)` values that passed the contrast policy; `baseline` means clients show
 * Factory's own colors for that mode, with the reason.
 */
export type AppearanceModeResult =
  | {
      readonly kind: "inherited";
      readonly colors: Readonly<Record<AppearanceColorToken, string>>;
    }
  | { readonly kind: "baseline"; readonly explanation: string };

/**
 * One validated, dual-mode presentation of the T3 environment's default theme. Clients choose
 * the half for their own Light/Dark mode. `revision` changes whenever anything below does; the
 * binding fields identify the source the colors came from.
 */
export interface AppearancePresentation {
  readonly revision: string;
  readonly environmentId: string;
  /** The appearance grant the colors were read with: an opaque id and its expiry. */
  readonly grant: { readonly id: string; readonly expiresAt: string };
  /** The upstream T3 revision Factory's palette resolver was ported from. */
  readonly resolverPin: string;
  readonly theme: { readonly id: string; readonly name: string };
  readonly modes: Readonly<Record<Appearance, AppearanceModeResult>>;
}

/**
 * - `not-paired`: no appearance grant for the saved T3 endpoint.
 * - `connecting`: a grant is stored and Factory is reading T3's configuration.
 * - `following`: Factory follows the environment default theme.
 * - `unavailable`: T3 is unreachable or its environment cannot be matched to the T3 connection.
 * - `re-pair-required`: the grant expired or T3 revoked it; only manual pairing continues.
 */
export type T3AppearanceState =
  | "not-paired"
  | "connecting"
  | "following"
  | "unavailable"
  | "re-pair-required";

/** Theme-color status for Settings. It never carries a T3 credential. */
export interface T3Appearance {
  readonly state: T3AppearanceState;
  readonly explanation: string;
  /** The stored grant, also after it ended. `expiresSoon` warns before expiry. */
  readonly grant: {
    readonly pairedAt: string;
    readonly expiresAt: string;
    readonly expiresSoon: boolean;
  } | null;
  /** The last valid presentation of this session; kept through a transient outage only. */
  readonly presentation: AppearancePresentation | null;
}

export interface PairAppearanceInput {
  /** The pairing code or `/pair#token=` link T3 created with only `orchestration:read`. */
  readonly pairing: string;
}

/** Host-only theme-color enrollment; status reaches clients through live delivery. */
export const appearanceOperations = {
  pairAppearance: operation<PairAppearanceInput, T3Appearance>()({
    method: "POST",
    path: "/api/connection/appearance",
    body: "json",
  }),
  disconnectAppearance: operation<never, T3Appearance>()({
    method: "DELETE",
    path: "/api/connection/appearance",
  }),
};

import { operation } from "./operation.ts";

/**
 * Chat control's own language-model connection, separate from Agents, T3 and Run title
 * generation. `openai-compatible` speaks chat completions and `anthropic` the messages API.
 */
export type ChatModelProviderKind = "openai-compatible" | "anthropic";

/** The saved Language model section. The key itself never leaves the host's credential files. */
export interface ChatModelConfiguration {
  readonly providerKind: ChatModelProviderKind | null;
  /** An absolute HTTP(S) base URL, sent exactly as saved; null until supplied. */
  readonly baseUrl: string | null;
  /** Free-text model id as the provider names it. */
  readonly model: string | null;
  /** Whether a key is saved; without one, requests go out keyless. */
  readonly keyConfigured: boolean;
  /** Increases with every committed save; tests and stale-write checks name it. */
  readonly revision: number;
  /** When this revision was saved; null before the first save. */
  readonly savedAt: string | null;
}

/** The latest owner-requested synthetic Test: dated evidence, not conversational health. */
export interface ChatModelTestEvidence {
  /** The configuration revision that was tested; an older one dates the evidence. */
  readonly revision: number;
  readonly testedAt: string;
  readonly outcome: "succeeded" | "failed";
  /** Factory's own description; never a provider-supplied body. */
  readonly message: string;
}

/** Settings → Chat control → Language model, readable only on the Factory host. */
export interface ChatModelSettings {
  /** Chat control's persisted On/Off state. Every installation starts Off. */
  readonly chatControlEnabled: boolean;
  readonly configuration: ChatModelConfiguration;
  readonly latestTest: ChatModelTestEvidence | null;
}

/**
 * What a save does with the saved key. A blank form field keeps it; `reuse` is the explicit
 * choice to send the saved key to a changed provider kind or base URL.
 */
export type ChatModelKeyChange =
  | { readonly kind: "keep" }
  | { readonly kind: "reuse" }
  | { readonly kind: "replace"; readonly value: string }
  | { readonly kind: "remove" };

export interface UpdateChatModelInput {
  /** The revision the edits started from; a different current revision is a conflict. */
  readonly revision: number;
  readonly providerKind: ChatModelProviderKind | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly key: ChatModelKeyChange;
}

export interface TestChatModelInput {
  /** The saved revision the owner chose to test; unsaved edits are never tested. */
  readonly revision: number;
}

/**
 * What a save does with the saved bot token. A blank form field keeps it; replacement and
 * removal are explicit.
 */
export type DiscordTokenChange =
  | { readonly kind: "keep" }
  | { readonly kind: "replace"; readonly value: string }
  | { readonly kind: "remove" };

/** The saved Discord connection section. The token itself never leaves the host's credential files. */
export interface DiscordConnectionConfiguration {
  /** The expected Application ID, a decimal Discord ID kept as text; null until supplied. */
  readonly applicationId: string | null;
  /** The application's non-secret Public Key, 64 lowercase hexadecimal characters. */
  readonly publicKey: string | null;
  /** Whether a bot token is saved. */
  readonly tokenConfigured: boolean;
  /** Increases with every committed save; checks and stale-write checks name it. */
  readonly revision: number;
  /** When this revision was saved; null before the first save. */
  readonly savedAt: string | null;
}

/**
 * How the latest connection-only check ended. Only `verified` means Discord authenticated the
 * saved token as the configured application over a ready Gateway session.
 */
export type DiscordCheckOutcome =
  | "verified"
  | "identity-mismatch"
  | "token-rejected"
  | "intent-disallowed"
  | "unreachable"
  | "timed-out"
  | "failed";

/** The latest owner-requested connection-only check: dated evidence for one saved revision. */
export interface DiscordCheckEvidence {
  /** The configuration revision that was checked; an older one dates the evidence. */
  readonly revision: number;
  readonly checkedAt: string;
  readonly outcome: DiscordCheckOutcome;
  /** Factory's own description; never a Discord-supplied body. */
  readonly message: string;
}

/**
 * The Gateway connection as Factory runs it now. While Chat control is Off the only connection is
 * an owner-requested check.
 */
export type DiscordConnectionStatus = "incomplete" | "off" | "checking";

/** Settings → Chat control → Discord, readable only on the Factory host. */
export interface DiscordSettings {
  /** Chat control's persisted On/Off state. Every installation starts Off. */
  readonly chatControlEnabled: boolean;
  readonly connectionStatus: DiscordConnectionStatus;
  readonly configuration: DiscordConnectionConfiguration;
  readonly latestCheck: DiscordCheckEvidence | null;
}

export interface UpdateDiscordConnectionInput {
  /** The revision the edits started from; a different current revision is a conflict. */
  readonly revision: number;
  readonly applicationId: string | null;
  readonly publicKey: string | null;
  readonly token: DiscordTokenChange;
  /**
   * The owner's acknowledgement that replacing a saved Application ID with another one connects a
   * different bot. Required for that change and ignored otherwise.
   */
  readonly applicationChangeConfirmed: boolean;
}

export interface CheckDiscordConnectionInput {
  /** The saved revision the owner chose to check; unsaved edits are never checked. */
  readonly revision: number;
}

/** Host-only Chat control administration; approved clients get `host_only`. */
export const chatControlOperations = {
  getChatModelSettings: operation<never, ChatModelSettings>()({
    method: "GET",
    path: "/api/chat-control/model",
  }),
  updateChatModelSettings: operation<UpdateChatModelInput, ChatModelSettings>()({
    method: "PUT",
    path: "/api/chat-control/model",
    body: "json",
  }),
  testChatModel: operation<TestChatModelInput, ChatModelSettings>()({
    method: "POST",
    path: "/api/chat-control/model/test",
    body: "json",
  }),
  getDiscordSettings: operation<never, DiscordSettings>()({
    method: "GET",
    path: "/api/chat-control/discord",
  }),
  updateDiscordConnection: operation<UpdateDiscordConnectionInput, DiscordSettings>()({
    method: "PUT",
    path: "/api/chat-control/discord/connection",
    body: "json",
  }),
  checkDiscordConnection: operation<CheckDiscordConnectionInput, DiscordSettings>()({
    method: "POST",
    path: "/api/chat-control/discord/check",
    body: "json",
  }),
};

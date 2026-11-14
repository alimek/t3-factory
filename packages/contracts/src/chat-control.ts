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

/**
 * The latest actual conversational failure of the Language model. Only a later successful
 * conversational request clears it; synthetic Tests neither set nor clear it.
 */
export interface ChatModelRuntimeProblem {
  /** The configuration revision the failing conversation used; an older one dates the problem. */
  readonly revision: number;
  readonly occurredAt: string;
  /** Factory's own description; never a provider-supplied body. */
  readonly message: string;
}

/** Settings → Chat control → Language model, readable only on the Factory host. */
export interface ChatModelSettings {
  /** Chat control's persisted On/Off state. Every installation starts Off. */
  readonly chatControlEnabled: boolean;
  readonly configuration: ChatModelConfiguration;
  readonly latestTest: ChatModelTestEvidence | null;
  readonly runtimeProblem: ChatModelRuntimeProblem | null;
  /** Whether the Language model navigation item shows an indicator: an unresolved runtime problem while On. */
  readonly needsAttention: boolean;
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
 * an owner-requested check; while On, Factory's single operating connection is `connecting`,
 * `connected`, `reconnecting` after a transient failure, or `rejected` after a failure that needs
 * correction and an explicit Retry.
 */
export type DiscordConnectionStatus =
  | "incomplete"
  | "off"
  | "checking"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "rejected";

/** Why the operating connection is reconnecting or rejected; Factory's own description. */
export interface DiscordConnectionProblem {
  readonly outcome: DiscordCheckOutcome;
  readonly message: string;
  readonly occurredAt: string;
}

/**
 * The outcome of registering `/factory reset` for the verified application on the latest
 * operating connection. A connected Gateway does not by itself mean the command works.
 */
export interface DiscordCommandSetup {
  readonly outcome: "registered" | "failed";
  readonly message: string;
  readonly occurredAt: string;
}

/** One allowed parent channel and the Projects it grants; its threads inherit the grant. */
export interface DiscordAccessChannel {
  /** A decimal Discord channel ID kept as text. */
  readonly channelId: string;
  /** Factory Project IDs; an empty list grants nothing. */
  readonly projectIds: readonly string[];
}

/** The saved Access section: who may invoke Chat control, where, and for which Projects. */
export interface DiscordAccessConfiguration {
  /** Decimal Discord user IDs kept as text. Roles and server membership grant nothing. */
  readonly users: readonly string[];
  readonly channels: readonly DiscordAccessChannel[];
  /** Granted Project IDs no Factory Project has; they stay listed and grant nothing. */
  readonly unresolvedProjectIds: readonly string[];
  /** Increases with every committed save; stale-write checks name it. */
  readonly revision: number;
  /** When this revision was saved; null before the first save. */
  readonly savedAt: string | null;
}

/**
 * An owed Chat control message Factory could not deliver on its own yet: `retrying` after a
 * definite transient rejection, `failed` when Discord definitely refused it (the destination or
 * the bot's permissions need correction), `unknown` when Factory cannot tell whether Discord
 * created it, which only a warned host Retry may send again.
 */
export interface ChatDeliveryProblem {
  readonly id: string;
  /** What the message is; receipts report a confirmed action's actual result. */
  readonly purpose: "receipt";
  readonly state: "retrying" | "failed" | "unknown";
  /** The destination thread and its parent channel, as decimal Discord IDs. */
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly threadId: string;
  /** Factory's own description of the latest attempt; never Discord's response body. */
  readonly message: string;
  readonly occurredAt: string;
  /** The next automatic attempt while `retrying`; null otherwise. */
  readonly nextAttemptAt: string | null;
}

/** The Factory operations a Chat control action can perform, one shared operation each. */
export type ChatActionOperation = "start" | "human-answer";

/** A confirmed action whose local outcome Factory has not reconciled yet. */
export interface ChatActionReconciliation {
  readonly id: string;
  readonly operation: ChatActionOperation;
  readonly startedAt: string;
}

/** Current delivery and action recovery facts; bounded, without chat content. */
export interface ChatDeliveryDiagnostics {
  /** The newest problems, at most 20. */
  readonly problems: readonly ChatDeliveryProblem[];
  /** How many more current problems exist beyond `problems`. */
  readonly moreProblems: number;
  readonly reconciling: readonly ChatActionReconciliation[];
}

/** Settings → Chat control → Discord, readable only on the Factory host. */
export interface DiscordSettings {
  /** Chat control's persisted On/Off state. Every installation starts Off. */
  readonly chatControlEnabled: boolean;
  readonly connectionStatus: DiscordConnectionStatus;
  /** The current reconnecting or rejected cause while On; null otherwise. */
  readonly connectionProblem: DiscordConnectionProblem | null;
  /** Command setup on the current operating connection; null while Off or not yet attempted. */
  readonly commandSetup: DiscordCommandSetup | null;
  /** Whether a current unresolved failure warrants the Settings navigation indicator; never while Off. */
  readonly needsAttention: boolean;
  readonly configuration: DiscordConnectionConfiguration;
  readonly access: DiscordAccessConfiguration;
  readonly latestCheck: DiscordCheckEvidence | null;
  readonly delivery: ChatDeliveryDiagnostics;
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
  /**
   * The saved revision the owner chose to check; unsaved edits are never checked. While Chat
   * control is On the request inspects the running connection and retries it when it is not
   * connected, instead of opening another session.
   */
  readonly revision: number;
}

export interface UpdateDiscordAccessInput {
  /** The revision the edits started from; a different current revision is a conflict. */
  readonly revision: number;
  readonly users: readonly string[];
  readonly channels: readonly DiscordAccessChannel[];
}

export interface SetChatControlEnabledInput {
  /** On needs a complete saved Discord connection and Language model; Off always succeeds. */
  readonly enabled: boolean;
}

export interface RetryChatDeliveryInput {
  readonly deliveryId: string;
  /**
   * The owner's acknowledgement that Discord may already show the message, so Retry can post a
   * duplicate. Required for an `unknown` delivery and ignored otherwise.
   */
  readonly duplicateRiskAccepted: boolean;
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
  updateDiscordAccess: operation<UpdateDiscordAccessInput, DiscordSettings>()({
    method: "PUT",
    path: "/api/chat-control/discord/access",
    body: "json",
  }),
  setChatControlEnabled: operation<SetChatControlEnabledInput, DiscordSettings>()({
    method: "PUT",
    path: "/api/chat-control/enabled",
    body: "json",
  }),
  retryChatDelivery: operation<RetryChatDeliveryInput, DiscordSettings>()({
    method: "POST",
    path: "/api/chat-control/deliveries/retry",
    body: "json",
  }),
};

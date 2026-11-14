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
};

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, type LanguageModel } from "ai";
import type { ChatModelProviderKind } from "@t3-factory/contracts";

/** A complete saved connection with its resolved key; null means keyless. */
export interface ChatModelConnection {
  readonly providerKind: ChatModelProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly key: string | null;
}

// The Anthropic provider requires a key and would otherwise read ANTHROPIC_API_KEY; a keyless
// server receives this fixed placeholder instead.
const KEYLESS_ANTHROPIC_KEY = "factory-keyless";
const TEST_TIMEOUT_MS = 30_000;

/**
 * The AI SDK model for exactly the saved values. Every setting is passed explicitly, so the
 * server's environment can never change the provider, destination or key.
 */
export function chatLanguageModel(connection: ChatModelConnection): LanguageModel {
  if (connection.providerKind === "anthropic")
    return createAnthropic({
      baseURL: connection.baseUrl,
      apiKey: connection.key ?? KEYLESS_ANTHROPIC_KEY,
    })(connection.model);
  return createOpenAICompatible({
    name: "factory-chat",
    baseURL: connection.baseUrl,
    ...(connection.key === null ? {} : { apiKey: connection.key }),
  })(connection.model);
}

/**
 * Factory's own description of a failed request. Provider bodies, URLs and SDK messages can
 * echo credentials or arbitrary content, so only the status code and a category leave here.
 */
export function failureMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return `The provider did not answer within ${timeoutMs / 1000} seconds.`;
  if (!APICallError.isInstance(error))
    return "The provider's answer could not be read as a model response.";
  const status = error.statusCode;
  if (status === undefined) return "Factory could not reach the provider at the saved base URL.";
  if (status === 401 || status === 403)
    return `The provider refused the request (HTTP ${status}). Check the key.`;
  if (status === 404)
    return "The provider answered HTTP 404. Check the base URL, including any version segment, and the model name.";
  if (status === 429) return "The provider is rate limiting requests (HTTP 429).";
  return `The provider answered HTTP ${status}.`;
}

export type SyntheticTestOutcome =
  | { readonly outcome: "succeeded"; readonly message: string }
  | { readonly outcome: "failed"; readonly message: string };

/**
 * One short synthetic request with fixed text and no tools, Run content or retries. It may be
 * charged by the provider, so it runs only when the owner asks for it.
 */
export async function requestSyntheticReply(
  connection: ChatModelConnection,
): Promise<SyntheticTestOutcome> {
  try {
    await generateText({
      model: chatLanguageModel(connection),
      prompt: "This is a connection test from T3 Factory. Reply with the single word OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    return { outcome: "succeeded", message: "The provider answered the synthetic request." };
  } catch (error) {
    return { outcome: "failed", message: failureMessage(error, TEST_TIMEOUT_MS) };
  }
}

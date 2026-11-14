import type {
  ChatModelKeyChange,
  ChatModelProviderKind,
  Result,
  TestChatModelInput,
  UpdateChatModelInput,
} from "@t3-factory/contracts";

export const CHAT_MODEL_PROVIDER_KINDS: readonly ChatModelProviderKind[] = [
  "openai-compatible",
  "anthropic",
];
export const CHAT_MODEL_BASE_URL_LIMIT = 2048;
export const CHAT_MODEL_NAME_LIMIT = 200;
export const CHAT_MODEL_KEY_LIMIT = 4096;

const invalid = (code: string, path: string, message: string): Result<never> => ({
  ok: false,
  error: { code: "validation", message, issues: [{ code, path, message }] },
});

// Control characters and whitespace inside a value never belong to a URL, model id or key.
const hasControlCharacter = (value: string) => /\p{Cc}/u.test(value);

const ANTHROPIC_VERSION_SEGMENT =
  "Anthropic base URLs include the API version segment, such as https://api.anthropic.com/v1; Factory sends requests to the base URL followed by /messages.";

/**
 * A literal absolute HTTP(S) base URL, kept exactly as entered apart from surrounding whitespace.
 * Credentials, queries and fragments are refused; proxy paths are preserved. An Anthropic base
 * URL without a path is refused instead of having its version segment appended silently.
 */
export function validateChatModelBaseUrl(
  value: string,
  providerKind: ChatModelProviderKind | null,
): Result<string> {
  const text = value.trim();
  const path = "baseUrl";
  if (text.length === 0 || text.length > CHAT_MODEL_BASE_URL_LIMIT)
    return invalid(
      "chat_model_base_url",
      path,
      `Enter a base URL up to ${CHAT_MODEL_BASE_URL_LIMIT} characters.`,
    );
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    url = new URL("invalid:");
  }
  if (!/^https?:\/\//i.test(text) || !["http:", "https:"].includes(url.protocol) || !url.host)
    return invalid(
      "chat_model_base_url",
      path,
      "Enter an absolute http:// or https:// base URL, such as https://api.example.com/v1.",
    );
  if (/\s/u.test(text) || hasControlCharacter(text))
    return invalid("chat_model_base_url", path, "A base URL cannot contain spaces.");
  if (url.username || url.password || text.slice(0, text.indexOf(url.host)).includes("@"))
    return invalid(
      "chat_model_base_url_credentials",
      path,
      "Remove the credentials from the base URL; enter the key in its own field.",
    );
  if (text.includes("?"))
    return invalid("chat_model_base_url_query", path, "Remove the query from the base URL.");
  if (text.includes("#"))
    return invalid("chat_model_base_url_fragment", path, "Remove the fragment from the base URL.");
  if (providerKind === "anthropic" && (url.pathname === "/" || url.pathname === ""))
    return invalid("chat_model_base_url_version", path, ANTHROPIC_VERSION_SEGMENT);
  return { ok: true, value: text };
}

function parseKeyChange(value: unknown): Result<ChatModelKeyChange> {
  const fields =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (fields.kind === "keep" || fields.kind === "reuse" || fields.kind === "remove")
    return { ok: true, value: { kind: fields.kind } };
  if (fields.kind !== "replace")
    return invalid(
      "chat_model_key",
      "key",
      "Say whether to keep, reuse, replace or remove the key.",
    );
  const key = typeof fields.value === "string" ? fields.value.trim() : "";
  if (key.length === 0 || key.length > CHAT_MODEL_KEY_LIMIT || /\s/u.test(key))
    return invalid(
      "chat_model_key",
      "key.value",
      `Enter a replacement key up to ${CHAT_MODEL_KEY_LIMIT} characters without spaces.`,
    );
  return { ok: true, value: { kind: "replace", value: key } };
}

const parseRevision = (value: unknown): Result<number> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : invalid("chat_model_revision", "revision", "Name the saved revision these edits start from.");

function parseProviderKind(value: unknown): Result<ChatModelProviderKind | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  return CHAT_MODEL_PROVIDER_KINDS.includes(value as ChatModelProviderKind)
    ? { ok: true, value: value as ChatModelProviderKind }
    : invalid("chat_model_provider_kind", "providerKind", "Choose OpenAI-compatible or Anthropic.");
}

function parseBaseUrl(
  value: unknown,
  providerKind: ChatModelProviderKind | null,
): Result<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  return typeof value === "string"
    ? validateChatModelBaseUrl(value, providerKind)
    : invalid("chat_model_base_url", "baseUrl", "Enter the base URL as text.");
}

function parseModel(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  const text = typeof value === "string" ? value.trim() : "";
  return text.length === 0 || text.length > CHAT_MODEL_NAME_LIMIT || hasControlCharacter(text)
    ? invalid(
        "chat_model_name",
        "model",
        `Enter a model name up to ${CHAT_MODEL_NAME_LIMIT} characters.`,
      )
    : { ok: true, value: text };
}

/**
 * Structural validation of a Language model save. Missing required fields are permitted here;
 * whether they may be removed depends on Chat control's current state, which the backend checks.
 */
export function validateUpdateChatModel(input: unknown): Result<UpdateChatModelInput> {
  const fields =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const revision = parseRevision(fields.revision);
  if (!revision.ok) return revision;
  const providerKind = parseProviderKind(fields.providerKind);
  if (!providerKind.ok) return providerKind;
  const baseUrl = parseBaseUrl(fields.baseUrl, providerKind.value);
  if (!baseUrl.ok) return baseUrl;
  const model = parseModel(fields.model);
  if (!model.ok) return model;
  const key = parseKeyChange(fields.key);
  if (!key.ok) return key;
  return {
    ok: true,
    value: {
      revision: revision.value,
      providerKind: providerKind.value,
      baseUrl: baseUrl.value,
      model: model.value,
      key: key.value,
    },
  };
}

export function validateTestChatModel(input: unknown): Result<TestChatModelInput> {
  const revision = parseRevision(
    typeof input === "object" && input !== null && "revision" in input ? input.revision : undefined,
  );
  return revision.ok ? { ok: true, value: { revision: revision.value } } : revision;
}

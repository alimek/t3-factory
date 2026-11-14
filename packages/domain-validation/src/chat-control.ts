import type {
  CheckDiscordConnectionInput,
  DiscordAccessChannel,
  DiscordTokenChange,
  SetChatControlEnabledInput,
  UpdateDiscordAccessInput,
  UpdateDiscordConnectionInput,
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

const parseRevision = (value: unknown, code = "chat_model_revision"): Result<number> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : invalid(code, "revision", "Name the saved revision these edits start from.");

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

const DISCORD_TOKEN_LIMIT = 512;
const DISCORD_ID_MAX = 2n ** 64n - 1n;

/**
 * A Discord ID (snowflake) as a trimmed decimal string. It is never converted to a JavaScript
 * number, which cannot hold every 64-bit ID exactly.
 */
export function validateDiscordId(
  value: string,
  code: string,
  path: string,
  label: string,
): Result<string> {
  const text = value.trim();
  return /^[1-9][0-9]{16,19}$/.test(text) && BigInt(text) <= DISCORD_ID_MAX
    ? { ok: true, value: text }
    : invalid(code, path, `Enter the ${label} as the 17 to 20 digit number Discord shows.`);
}

/** The application's Public Key from the Developer Portal: 64 hexadecimal characters. */
export function validateDiscordPublicKey(value: string): Result<string> {
  const text = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text)
    ? { ok: true, value: text }
    : invalid(
        "discord_public_key",
        "publicKey",
        "Enter the Public Key as the 64 hexadecimal characters the Developer Portal shows.",
      );
}

function parseOptionalText<A>(
  value: unknown,
  parse: (text: string) => Result<A>,
  fallback: Result<never>,
): Result<A | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  return typeof value === "string" ? parse(value) : fallback;
}

function parseTokenChange(value: unknown): Result<DiscordTokenChange> {
  const fields =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (fields.kind === "keep" || fields.kind === "remove")
    return { ok: true, value: { kind: fields.kind } };
  if (fields.kind !== "replace")
    return invalid("discord_token", "token", "Say whether to keep, replace or remove the token.");
  const token = typeof fields.value === "string" ? fields.value.trim() : "";
  if (token.length === 0 || token.length > DISCORD_TOKEN_LIMIT || /\s/u.test(token))
    return invalid(
      "discord_token",
      "token.value",
      `Enter a replacement bot token up to ${DISCORD_TOKEN_LIMIT} characters without spaces.`,
    );
  return { ok: true, value: { kind: "replace", value: token } };
}

/**
 * Structural validation of a Discord connection save. Missing required fields are permitted here;
 * whether they may be removed depends on Chat control's current state, which the backend checks.
 */
export function validateUpdateDiscordConnection(
  input: unknown,
): Result<UpdateDiscordConnectionInput> {
  const fields =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const revision = parseRevision(fields.revision, "discord_revision");
  if (!revision.ok) return revision;
  const applicationId = parseOptionalText(
    fields.applicationId,
    (text) => validateDiscordId(text, "discord_application_id", "applicationId", "Application ID"),
    invalid("discord_application_id", "applicationId", "Enter the Application ID as text."),
  );
  if (!applicationId.ok) return applicationId;
  const publicKey = parseOptionalText(
    fields.publicKey,
    validateDiscordPublicKey,
    invalid("discord_public_key", "publicKey", "Enter the Public Key as text."),
  );
  if (!publicKey.ok) return publicKey;
  const token = parseTokenChange(fields.token);
  if (!token.ok) return token;
  return {
    ok: true,
    value: {
      revision: revision.value,
      applicationId: applicationId.value,
      publicKey: publicKey.value,
      token: token.value,
      applicationChangeConfirmed: fields.applicationChangeConfirmed === true,
    },
  };
}

export function validateCheckDiscordConnection(
  input: unknown,
): Result<CheckDiscordConnectionInput> {
  const revision = parseRevision(
    typeof input === "object" && input !== null && "revision" in input ? input.revision : undefined,
    "discord_revision",
  );
  return revision.ok ? { ok: true, value: { revision: revision.value } } : revision;
}

export const DISCORD_ACCESS_USER_LIMIT = 100;
export const DISCORD_ACCESS_CHANNEL_LIMIT = 100;
const PROJECT_ID_LIMIT = 200;

/** Decimal Discord IDs at `path`; a repeated ID is refused rather than silently merged. */
function parseDiscordIds(
  value: unknown,
  path: string,
  limit: number,
  code: string,
  label: string,
): Result<string[]> {
  if (!Array.isArray(value) || value.length > limit)
    return invalid(code, path, `List at most ${limit} ${label}s.`);
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    const id =
      typeof item === "string"
        ? validateDiscordId(item, code, `${path}[${index}]`, label)
        : invalid(code, `${path}[${index}]`, `Enter the ${label} as text.`);
    if (!id.ok) return id;
    if (ids.includes(id.value))
      return invalid(
        "discord_access_duplicate",
        `${path}[${index}]`,
        `${id.value} is listed twice. Remove the repeated ${label}.`,
      );
    ids.push(id.value);
  }
  return { ok: true, value: ids };
}

function parseProjectIds(value: unknown, path: string): Result<string[]> {
  if (!Array.isArray(value))
    return invalid("discord_access_project", path, "List the Projects this channel grants.");
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    const id = typeof item === "string" ? item.trim() : "";
    if (id.length === 0 || id.length > PROJECT_ID_LIMIT || hasControlCharacter(id))
      return invalid("discord_access_project", `${path}[${index}]`, "Choose a Factory Project.");
    if (ids.includes(id))
      return invalid(
        "discord_access_duplicate",
        `${path}[${index}]`,
        "This Project is granted twice to the channel. Remove the repeated grant.",
      );
    ids.push(id);
  }
  return { ok: true, value: ids };
}

function parseChannels(value: unknown): Result<DiscordAccessChannel[]> {
  if (!Array.isArray(value) || value.length > DISCORD_ACCESS_CHANNEL_LIMIT)
    return invalid(
      "discord_access_channel",
      "channels",
      `List at most ${DISCORD_ACCESS_CHANNEL_LIMIT} channels.`,
    );
  const channels: DiscordAccessChannel[] = [];
  for (const [index, item] of value.entries()) {
    const fields = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const channelId =
      typeof fields.channelId === "string"
        ? validateDiscordId(
            fields.channelId,
            "discord_access_channel",
            `channels[${index}].channelId`,
            "channel ID",
          )
        : invalid(
            "discord_access_channel",
            `channels[${index}].channelId`,
            "Enter the channel ID as text.",
          );
    if (!channelId.ok) return channelId;
    if (channels.some((channel) => channel.channelId === channelId.value))
      return invalid(
        "discord_access_duplicate",
        `channels[${index}].channelId`,
        `${channelId.value} is listed twice. Combine its Projects in one channel entry.`,
      );
    const projectIds = parseProjectIds(fields.projectIds, `channels[${index}].projectIds`);
    if (!projectIds.ok) return projectIds;
    channels.push({ channelId: channelId.value, projectIds: projectIds.value });
  }
  return { ok: true, value: channels };
}

/**
 * Structural validation of an Access save: trimmed decimal IDs, no repeated user, channel or
 * per-channel Project. Whether the Projects exist is checked by the backend.
 */
export function validateUpdateDiscordAccess(input: unknown): Result<UpdateDiscordAccessInput> {
  const fields =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const revision = parseRevision(fields.revision, "discord_access_revision");
  if (!revision.ok) return revision;
  const users = parseDiscordIds(
    fields.users,
    "users",
    DISCORD_ACCESS_USER_LIMIT,
    "discord_access_user",
    "user ID",
  );
  if (!users.ok) return users;
  const channels = parseChannels(fields.channels);
  if (!channels.ok) return channels;
  return {
    ok: true,
    value: { revision: revision.value, users: users.value, channels: channels.value },
  };
}

export function validateSetChatControlEnabled(input: unknown): Result<SetChatControlEnabledInput> {
  const enabled =
    typeof input === "object" && input !== null && "enabled" in input ? input.enabled : undefined;
  return typeof enabled === "boolean"
    ? { ok: true, value: { enabled } }
    : invalid("chat_control_enabled", "enabled", "Say whether Chat control is On or Off.");
}

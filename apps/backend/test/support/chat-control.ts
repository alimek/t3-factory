import { assert } from "@effect/vitest";
import type {
  ChatModelSettings,
  DiscordSettings,
  UpdateChatModelInput,
  UpdateDiscordConnectionInput,
} from "@t3-factory/contracts";
import type { Factory } from "../../src/index.ts";

/** A complete keyless OpenAI-compatible save from the empty section, with overrides. */
export const chatModelSave = (overrides: Partial<UpdateChatModelInput> = {}) =>
  ({
    revision: 0,
    providerKind: "openai-compatible",
    baseUrl: "https://gateway.example/v1",
    model: "model-a",
    key: { kind: "keep" },
    ...overrides,
  }) satisfies UpdateChatModelInput;

/** The Language model saved once from the empty section; the save must succeed. */
export async function savedChatModel(
  factory: Pick<Factory, "updateChatModelSettings">,
  overrides: Partial<UpdateChatModelInput> = {},
): Promise<ChatModelSettings> {
  const saved = await factory.updateChatModelSettings(chatModelSave(overrides));
  assert(saved.ok, JSON.stringify(saved));
  return saved.value;
}

/** The application the controlled Discord knows for `DISCORD_TOKEN`. */
export const discordBot = {
  token: "controlled-bot-token.discord.secret",
  applicationId: "123456789012345678",
} as const;

export const DISCORD_PUBLIC_KEY = "a".repeat(64);

/** A complete Discord connection save from the empty section, with overrides. */
export const discordConnectionSave = (overrides: Partial<UpdateDiscordConnectionInput> = {}) =>
  ({
    revision: 0,
    applicationId: discordBot.applicationId,
    publicKey: DISCORD_PUBLIC_KEY,
    token: { kind: "replace", value: discordBot.token },
    applicationChangeConfirmed: false,
    ...overrides,
  }) satisfies UpdateDiscordConnectionInput;

/** The Discord connection saved once from the empty section; the save must succeed. */
export async function savedDiscordConnection(
  factory: Pick<Factory, "updateDiscordConnection">,
  overrides: Partial<UpdateDiscordConnectionInput> = {},
): Promise<DiscordSettings> {
  const saved = await factory.updateDiscordConnection(discordConnectionSave(overrides));
  assert(saved.ok, JSON.stringify(saved));
  return saved.value;
}

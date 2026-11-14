import { assert, type TestContext } from "@effect/vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatModelSettings,
  DiscordSettings,
  UpdateChatModelInput,
  UpdateDiscordConnectionInput,
} from "@t3-factory/contracts";
import type { Factory } from "../../src/index.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import {
  controlledDiscord,
  messageEvent,
  PARTICIPANT_ID,
  type ControlledDiscord,
  type DiscordRestRequest,
  type GatewaySession,
} from "./controlled-discord.ts";
import { controlledModelProvider } from "./controlled-model.ts";
import { factoryHarness } from "./factory.ts";

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
    publicKey: DISCORD_PUBLIC_KEY,
    token: { kind: "replace", value: discordBot.token },
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

export const ALLOWED_CHANNEL = "400000000000000002";
export const OTHER_CHANNEL = "400000000000000003";

/** The server the controlled Discord's bot is a member of. */
export const discordGuild = {
  id: "400000000000000001",
  name: "Team",
  channels: [
    { id: ALLOWED_CHANNEL, name: "factory" },
    { id: OTHER_CHANNEL, name: "general" },
  ],
} as const;

/**
 * Factory on a fresh home with one Project, a complete keyless Language model on the controlled
 * model provider (answering "OK" unless scripted), a complete Discord
 * connection to the controlled Discord, and Access allowing the participant in the allowed channel
 * for that Project. Chat control is still Off.
 */
export async function chatControlWorld(c: TestContext) {
  const model = await controlledModelProvider(c);
  const discord = await controlledDiscord(c);
  discord.addBot(discordBot);
  discord.addGuild(discordGuild);
  const harness = await factoryHarness(c);
  const root = join(harness.processHome, "project");
  await mkdir(root);
  const t3 = new ControlledT3();
  t3.approve();
  const open = () => harness.open({ t3, discordApiUrl: discord.apiUrl, connectionRetryMs: 60_000 });
  const factory = await open();
  await factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
  const project = await factory.addRepository({ path: root });
  assert(project.ok, JSON.stringify(project));
  await savedChatModel(factory, { baseUrl: model.baseUrl() });
  await savedDiscordConnection(factory);
  const access = await factory.updateDiscordAccess({
    revision: 0,
    users: [PARTICIPANT_ID],
    channels: [{ channelId: ALLOWED_CHANNEL, projectIds: [project.value.id] }],
  });
  assert(access.ok, JSON.stringify(access));
  return { discord, model, harness, open, factory, project: project.value };
}

const COMMANDS = /^\/api\/v10\/applications\/\d+\/commands$/;

/**
 * Turns Chat control On and waits until the operating session serves traffic: Factory registers
 * its command right after attaching its handlers. `registrations` counts every registration so far.
 */
export async function turnedOn(
  factory: Pick<Factory, "setChatControlEnabled">,
  discord: ControlledDiscord,
  registrations = 1,
) {
  const on = await factory.setChatControlEnabled({ enabled: true });
  assert(on.ok, JSON.stringify(on));
  await discord.request("POST", COMMANDS, registrations);
}

/** Waits until a reopened Factory with a persisted On state serves traffic again. */
export const servingAgain = (discord: ControlledDiscord, registrations: number) =>
  discord.request("POST", COMMANDS, registrations);

export const THREADS = /^\/api\/v10\/channels\/\d+\/messages\/\d+\/threads$/;
export const POSTS = /^\/api\/v10\/channels\/\d+\/messages$/;

/**
 * Delivers an authorized invocation in the allowed channel and waits for its thread. Factory takes
 * events through its gate in delivery order, so every event delivered before it has been decided.
 */
export async function afterEarlierEvents(discord: ControlledDiscord, id: string) {
  discord.deliver(
    messageEvent({ bot: discordBot, guildId: discordGuild.id, channelId: ALLOWED_CHANNEL, id }),
  );
  await discord.request("POST", new RegExp(`/messages/${id}/threads$`));
}

/** The Gateway sessions Discord still has open. */
export const openSessions = (discord: ControlledDiscord): GatewaySession[] =>
  discord.sessions.filter((session) => !session.closed);

/** Requests besides command registration, Gateway discovery and the sentinel invocation's. */
export const requestsBesides = (discord: ControlledDiscord, sentinelId: string) =>
  discord.requests
    .filter(
      (request: DiscordRestRequest) =>
        !request.path.includes(sentinelId) &&
        !COMMANDS.test(request.path) &&
        request.path !== "/api/v10/gateway/bot",
    )
    .map((request) => `${request.method} ${request.path}`);

const OBSERVATION_PASSES = 2000;

/**
 * The Discord settings once `until` holds. Factory applies Discord's answers after receiving them,
 * so a barrier on the request alone can precede the state it causes; each pass reads the public
 * settings again after yielding to pending I/O, for a bounded number of passes.
 */
export async function discordSettingsWhen(
  factory: Pick<Factory, "getDiscordSettings">,
  until: (settings: DiscordSettings) => boolean,
) {
  for (let pass = 0; pass < OBSERVATION_PASSES; pass++) {
    const read = await factory.getDiscordSettings();
    assert(read.ok, JSON.stringify(read));
    if (until(read.value)) return read.value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Discord settings did not reach their condition in ${OBSERVATION_PASSES} reads.`);
}

export const statusIs =
  (status: DiscordSettings["connectionStatus"]) => (settings: DiscordSettings) =>
    settings.connectionStatus === status;

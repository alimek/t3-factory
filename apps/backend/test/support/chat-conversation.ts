import { assert, type TestContext } from "@effect/vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { Factory, FactoryService } from "../../src/index.ts";
import {
  ALLOWED_CHANNEL,
  chatControlWorld,
  chatModelSave,
  discordBot,
  discordConnectionSave,
  discordGuild,
  POSTS,
  turnedOn,
} from "./chat-control.ts";
import {
  controlledDiscord,
  messageEvent,
  PARTICIPANT_ID,
  type ControlledDiscord,
} from "./controlled-discord.ts";
import { controlledModelProvider, type ControlledModel } from "./controlled-model.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { factoryHarness } from "./factory.ts";

export const THREAD = "500000000000000001";
export const OTHER_THREAD = "500000000000000003";
export const COLLABORATOR_ID = "200000000000000002";

const COMMANDS = /^\/api\/v10\/applications\/\d+\/commands$/;

/** Adds the public threads `THREAD` and `OTHER_THREAD` of the allowed channel. */
export function addThreads(discord: ControlledDiscord) {
  for (const id of [THREAD, OTHER_THREAD])
    discord.addThread({
      id,
      guildId: discordGuild.id,
      parentId: ALLOWED_CHANNEL,
      name: "work",
      private: false,
      members: [],
    });
}

/**
 * An operating Chat control with two public threads in the allowed channel, where the participant
 * and a collaborator are allowed; the model answers "OK" unless scripted.
 */
export async function conversing(c: TestContext) {
  const world = await chatControlWorld(c);
  addThreads(world.discord);
  const access = await world.factory.updateDiscordAccess({
    revision: 1,
    users: [PARTICIPANT_ID, COLLABORATOR_ID],
    channels: [{ channelId: ALLOWED_CHANNEL, projectIds: [world.project.id] }],
  });
  assert(access.ok, JSON.stringify(access));
  await turnedOn(world.factory, world.discord);
  return world;
}

/** An invocation in `THREAD` (or the given channel) by the participant unless overridden. */
export const invocation = (
  id: string,
  overrides: Partial<Parameters<typeof messageEvent>[0]> = {},
) =>
  messageEvent({
    bot: discordBot,
    guildId: discordGuild.id,
    channelId: THREAD,
    id,
    ...overrides,
  });

/** The text of every message Factory posted, once at least `count` arrived. */
export async function posted(discord: ControlledDiscord, count = 1) {
  await discord.request("POST", POSTS, count);
  return discord
    .requested("POST", POSTS)
    .map((request) => (request.body as { content: string }).content);
}

/** Delivers an invocation and waits until Factory posted its `count`th message overall. */
export async function answered(
  discord: ControlledDiscord,
  id: string,
  count: number,
  overrides: Partial<Parameters<typeof messageEvent>[0]> = {},
) {
  discord.deliver(invocation(id, overrides));
  return posted(discord, count);
}

type WireMessage = {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: readonly { readonly function: { readonly name: string } }[];
};

/** The messages of the model request at `index`, as the OpenAI-compatible wire carried them. */
export const requestMessages = (model: ControlledModel, index: number) =>
  (model.requests[index]!.body as { messages: WireMessage[] }).messages;

/** The user envelopes of the request at `index`, parsed. */
export const userEnvelopes = (model: ControlledModel, index: number) =>
  requestMessages(model, index)
    .filter((message) => message.role === "user")
    .map((message) => JSON.parse(message.content as string) as Record<string, unknown>);

/** The tool results of the request at `index`, parsed. */
export const toolResults = (model: ControlledModel, index: number) =>
  requestMessages(model, index)
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(message.content as string) as Record<string, unknown>);

/** The system instructions of the request at `index`. */
export const systemText = (model: ControlledModel, index: number) =>
  requestMessages(model, index).find((message) => message.role === "system")!.content as string;

/** `count` completed turns in `THREAD`, each answered "OK", with message IDs from `firstId` on. */
export async function conversationOf(discord: ControlledDiscord, count: number, firstId: bigint) {
  for (let turn = 0; turn < count; turn++)
    await answered(discord, String(firstId + BigInt(turn)), turn + 1, {
      content: `request ${turn + 1}`,
    });
}

/** Saves Access allowing `users` in the allowed channel for `projectIds`. */
export async function savedAccess(
  factory: Pick<Factory, "getDiscordSettings" | "updateDiscordAccess">,
  users: readonly string[],
  projectIds: readonly string[],
) {
  const settings = await factory.getDiscordSettings();
  assert(settings.ok);
  const saved = await factory.updateDiscordAccess({
    revision: settings.value.access.revision,
    users,
    channels: [{ channelId: ALLOWED_CHANNEL, projectIds }],
  });
  assert(saved.ok, JSON.stringify(saved));
}

/**
 * The same operating world as `conversing`, built inside the test's Effect scope so TestClock
 * drives every interpretation deadline. Operations return Effects.
 */
export const clockedConversation = (c: TestContext) =>
  Effect.gen(function* () {
    const model = yield* Effect.promise(() => controlledModelProvider(c));
    const discord = yield* Effect.promise(() => controlledDiscord(c));
    discord.addBot(discordBot);
    discord.addGuild(discordGuild);
    addThreads(discord);
    const harness = yield* Effect.promise(() => factoryHarness(c));
    const root = join(harness.processHome, "project");
    yield* Effect.promise(() => mkdir(root));
    const t3 = new ControlledT3();
    t3.approve();
    const factory = yield* harness.service({
      t3,
      discordApiUrl: discord.apiUrl,
      connectionRetryMs: 60_000,
    });
    yield* factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
    const project = yield* factory.addRepository({ path: root });
    assert(project.ok, JSON.stringify(project));
    yield* operatingService(factory, { model, discord }, project.value.id);
    return { model, discord, factory, project: project.value };
  });

/**
 * Inside the test's Effect scope: saves the Language model on `model` and the connection, allows
 * the participant and collaborator for `projectId` in the allowed channel and turns Chat control
 * On, returning once the session serves traffic.
 */
export const operatingService = (
  factory: FactoryService["Service"],
  { model, discord }: { readonly model: ControlledModel; readonly discord: ControlledDiscord },
  projectId: string,
) =>
  Effect.gen(function* () {
    yield* factory.updateChatModelSettings(chatModelSave({ baseUrl: model.baseUrl() }));
    yield* factory.updateDiscordConnection(discordConnectionSave());
    const access = yield* factory.updateDiscordAccess({
      revision: 0,
      users: [PARTICIPANT_ID, COLLABORATOR_ID],
      channels: [{ channelId: ALLOWED_CHANNEL, projectIds: [projectId] }],
    });
    assert(access.ok, JSON.stringify(access));
    yield* factory.setChatControlEnabled({ enabled: true });
    yield* Effect.promise(() => discord.request("POST", COMMANDS));
  });

/** Waits for a promise inside an Effect test. */
export const until = <A>(promise: () => Promise<A>) => Effect.promise(promise);

import { assert, type TestContext } from "@effect/vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import type { Factory } from "../../src/index.ts";
import { ALLOWED_CHANNEL, discordBot, discordGuild } from "./chat-control.ts";
import { invocation, operatingService, THREAD } from "./chat-conversation.ts";
import { chatWorlds, runConversation } from "./chat-runs.ts";
import { buttonEvent, type ControlledDiscord, type CreatedMessage } from "./controlled-discord.ts";
import { preparedService } from "./prepared-runner.ts";

/**
 * An operating Chat control over a Factory that can start Runs (the prepared ready Flow of
 * `runConversation`). `open` reopens the same home against the same external worlds.
 */
export async function startingWorld(c: TestContext) {
  const fixture = await runConversation(c);
  const open = () =>
    fixture.h.open({
      t3: fixture.t3,
      reportingStateDirectory: join(fixture.h.processHome, "reporting-state"),
      discordApiUrl: fixture.discord.apiUrl,
      connectionRetryMs: 60_000,
    });
  return { ...fixture, factory: fixture.f, harness: fixture.h, open };
}

export type StartingWorld = Pick<
  Awaited<ReturnType<typeof startingWorld>>,
  "model" | "discord" | "project" | "flow"
>;

/**
 * The same operating world as `startingWorld`, built inside the test's Effect scope so TestClock
 * drives consent expiry and every other backend deadline. Operations return Effects.
 */
export const clockedStartingWorld = (c: TestContext) =>
  Effect.gen(function* () {
    const worlds = yield* Effect.promise(() => chatWorlds(c));
    const { factory, project, flow } = yield* preparedService(c, undefined, {
      discordApiUrl: worlds.discord.apiUrl,
    });
    yield* operatingService(factory, worlds, project.id);
    return { ...worlds, factory, project, flow };
  });

/** The model's start_run call for the world's Project and Flow with `prompt`. */
export const startCall = (
  world: Pick<StartingWorld, "project" | "flow">,
  prompt: string,
  overrides: Record<string, unknown> = {},
) => ({
  toolCalls: [
    {
      name: "start_run",
      input: {
        projectId: world.project.id,
        flowId: world.flow.id,
        prompt,
        promptSource: "requester-message",
        ...overrides,
      },
    },
  ],
});

export const START_PROMPT = "Improve search\nKeep it accessible.";

/** The custom ID of the confirmation button on `message`, if it carries one. */
const buttonOf = (message: CreatedMessage) =>
  (
    message.components as readonly {
      readonly components: readonly { readonly custom_id: string }[];
    }[]
  )[0]?.components[0]?.custom_id;

/** Messages Discord created so far that carry a confirmation button. */
export const confirmations = (discord: ControlledDiscord) =>
  discord.created.filter((message) => buttonOf(message) !== undefined);

/**
 * Delivers a participant invocation asking to start `prompt` (scripted as the model's start_run
 * call), and returns the confirmation button's custom ID once Factory created `messages` messages
 * in total, the last of them the button.
 */
export async function proposedStart(
  world: StartingWorld,
  id: string,
  messages: number,
  answer: ReturnType<typeof startCall> = startCall(world, START_PROMPT),
  content = `start this:\n${START_PROMPT}`,
) {
  world.model.script(answer);
  world.discord.deliver(invocation(id, { content }));
  await world.discord.createdMessages(messages);
  const button = buttonOf(world.discord.created.at(-1)!);
  assert(button !== undefined, "the last message carries the confirmation button");
  return button;
}

const ORIGINAL = /^\/api\/v10\/webhooks\/\d+\/[^/]+\/messages\/(?:@|%40)original$/;

/** The ephemeral answers Factory gave to interactions, in order. */
export const ephemeralAnswers = (discord: ControlledDiscord) =>
  discord
    .requested("PATCH", ORIGINAL)
    .map((request) => (request.body as { content: string }).content);

/**
 * Delivers a click on `customId` in `THREAD` and returns Factory's ephemeral answer once it is the
 * `answers`th answer overall.
 */
export async function clicked(
  discord: ControlledDiscord,
  customId: string,
  id: string,
  answers: number,
  options: { readonly userId?: string; readonly permissions?: bigint } = {},
) {
  discord.deliver(
    buttonEvent({
      bot: discordBot,
      guildId: discordGuild.id,
      thread: { id: THREAD, parentId: ALLOWED_CHANNEL },
      id,
      customId,
      ...options,
    }),
  );
  await discord.request("PATCH", ORIGINAL, answers);
  return ephemeralAnswers(discord).at(-1)!;
}

/** The Runs Factory shows in navigation, as identity and title. */
export async function runsOf(factory: Pick<Factory, "listRunNavigation">) {
  const navigation = await factory.listRunNavigation();
  assert(navigation.ok, JSON.stringify(navigation));
  return navigation.value.map((entry) => ({ number: entry.number, title: entry.title }));
}

/**
 * The originating thread Factory recorded for a Run. Origins are backend-private: no public read
 * exposes them, so this opens the database read-only.
 */
export function originatingThread(databasePath: string, runId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT thread_id FROM chat_run_origins WHERE run_id=?")
      .get(runId) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  } finally {
    database.close();
  }
}

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
import {
  humanReviewFlow,
  resultReleasedToHumanReview,
  resultReported,
  workerAtWork,
  type ReadyFlowShape,
} from "./scenarios.ts";

/**
 * An operating Chat control over a Factory that can start Runs (the prepared ready Flow of
 * `runConversation`). `open` reopens the same home against the same external worlds.
 */
export async function startingWorld(c: TestContext, shape?: ReadyFlowShape) {
  const fixture = await runConversation(c, shape);
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

/** The model asks for one mutation tool call. */
type MutationCall = { readonly toolCalls: readonly { name: string; input: unknown }[] };

/**
 * Delivers a participant invocation asking to start `prompt` (scripted as the model's start_run
 * call), and returns the confirmation button's custom ID once Factory created `messages` messages
 * in total, the last of them the button.
 */
export const proposedStart = (
  world: StartingWorld,
  id: string,
  messages: number,
  answer: MutationCall = startCall(world, START_PROMPT),
  content = `start this:\n${START_PROMPT}`,
) => proposed(world, id, messages, answer, content);

/**
 * Delivers a participant invocation with `content` whose interpretation is the model's `answer`
 * call, and returns the confirmation button's custom ID once Factory created `messages` messages
 * in total, the last of them the button.
 */
export async function proposed(
  world: Pick<StartingWorld, "model" | "discord">,
  id: string,
  messages: number,
  answer: MutationCall,
  content: string,
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

export const HUMAN_CONTEXT = "Review this change.\nCheck the empty state.";

/**
 * An operating Chat control over a Run started in Factory (Run #1) of the Human review Flow, whose
 * Review waits on its pending occurrence with the worker's result `context`.
 */
export async function answeringWorld(c: TestContext, context = HUMAN_CONTEXT) {
  const world = await startingWorld(c, humanReviewFlow);
  const worker = await workerAtWork(world.world, world.input);
  await resultReported(world.world, worker, { message: context });
  const review = await resultReleasedToHumanReview(world.world, worker);
  return { ...world, runId: worker.runId, occurrence: review.occurrence };
}

/** The model's answer_human call for the world's pending occurrence of Run #1. */
export const answerCall = (
  world: { readonly occurrence: { readonly id: string } },
  input: Record<string, unknown> = {},
) => ({
  toolCalls: [
    {
      name: "answer_human",
      input: { run: "#1", occurrenceId: world.occurrence.id, answer: "approve", ...input },
    },
  ],
});

/** The occurrence `id` of the Run as Factory shows it now. */
export async function occurrenceOf(factory: Pick<Factory, "getRun">, runId: string, id: string) {
  const run = await factory.getRun(runId);
  assert(run.ok, JSON.stringify(run));
  return {
    occurrence: run.value.humanOccurrences.find((entry) => entry.id === id)!,
    handoffs: run.value.intents.filter((intent) => intent.occurrenceId === id),
  };
}

/**
 * An operating Chat control over a working Run started in Factory (Run #1 “Improve search”) whose
 * worker thread is bound, so Archive requests its interruption.
 */
export async function archivingWorld(c: TestContext) {
  const world = await startingWorld(c);
  const worker = await workerAtWork(world.world, world.input);
  return { ...world, runId: worker.runId };
}

/** The model's archive_run call for Run #1. */
export const archiveCall = (input: Record<string, unknown> = {}) => ({
  toolCalls: [{ name: "archive_run", input: { run: "#1", ...input } }],
});

/** The Run's lifecycle as Factory shows it now. */
export async function lifecycleOf(factory: Pick<Factory, "getRun">, runId: string) {
  const run = await factory.getRun(runId);
  assert(run.ok, JSON.stringify(run));
  return run.value.lifecycle;
}

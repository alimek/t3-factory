import { assert } from "@effect/vitest";
import type { DiscordSettings } from "@t3-factory/contracts";
import type { Factory } from "../../src/index.ts";
import {
  clicked,
  isStatusCard,
  proposedStart,
  START_PROMPT,
  startCall,
  type startingWorld,
} from "./chat-actions.ts";
import { discordSettingsWhen } from "./chat-control.ts";
import type { ControlledDiscord, CreatedMessage } from "./controlled-discord.ts";
import { launchedWorkers } from "./scenarios.ts";

type World = Awaited<ReturnType<typeof startingWorld>>;

/**
 * Starts a Run through a requester's confirmation in `THREAD` and waits for its status card.
 * `ordinal` numbers Starts in one world (1, 2, …): each adds a review of two messages, a receipt
 * and a card, and uses its own invocation and click IDs. Returns the Run, its launched worker and
 * the card message.
 */
export async function chatStartedRun(world: World, ordinal = 1, prompt = START_PROMPT) {
  const before = world.discord.created.length;
  const button = await proposedStart(
    world,
    `60000000000000000${ordinal}`,
    before + 2,
    startCall(world, prompt),
    `start this:\n${prompt}`,
  );
  await clicked(world.discord, button, `61000000000000000${ordinal}`, ordinal);
  await world.discord.createdWhere(isStatusCard, ordinal);
  const card = world.discord.created.filter(isStatusCard)[ordinal - 1]!;
  const navigation = await world.factory.listRunNavigation();
  assert(navigation.ok, JSON.stringify(navigation));
  const runId = navigation.value.find((entry) => entry.number === ordinal)!.id;
  const { workers } = await launchedWorkers(world.world, runId);
  return { runId, worker: workers[0]!, card };
}

/** Resolves with the message once Discord shows `shown` (a card or notice) matching `pattern`. */
export async function messageShows(
  discord: ControlledDiscord,
  shown: CreatedMessage,
  pattern: RegExp,
) {
  await discord.messagesWhen((messages) =>
    messages.some((message) => message.id === shown.id && pattern.test(message.content)),
  );
  return discord.created.find((message) => message.id === shown.id)!;
}

/** The Discord settings once a status card delivery problem in `state` is listed. */
export const cardProblem = (
  factory: Pick<Factory, "getDiscordSettings">,
  state: DiscordSettings["delivery"]["problems"][number]["state"],
) =>
  discordSettingsWhen(factory, (settings) =>
    settings.delivery.problems.some(
      (problem) => problem.purpose === "status-card" && problem.state === state,
    ),
  );

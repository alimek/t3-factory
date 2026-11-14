import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { resetCommandEvent, type ControlledDiscord } from "./support/controlled-discord.ts";
import { ALLOWED_CHANNEL, discordBot, discordGuild } from "./support/chat-control.ts";
import {
  answered,
  clockedConversation,
  conversing,
  invocation,
  OTHER_THREAD,
  THREAD,
  until,
} from "./support/chat-conversation.ts";

const TYPING = /^\/api\/v10\/channels\/\d+\/typing$/;
const UNLISTED_USER = "200000000000000099";
/** Discord shows a typing indicator for about ten seconds; Factory refreshes it before then. */
const REFRESH_MS = 8_000;

/** The thread of each typing trigger, in order. */
const typingIn = (discord: ControlledDiscord) =>
  discord.requested("POST", TYPING).map((request) => request.path.split("/")[4]);

it("an authorized invocation shows Factory typing in its thread while it is interpreted", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  model.held();

  // Act
  discord.deliver(invocation("300000000000000400"));

  // Assert
  await discord.request("POST", TYPING);
  expect(typingIn(discord)).toStrictEqual([THREAD]);
});

it("traffic from a user Access does not allow shows no typing", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  model.held();

  // Act
  discord.deliver(invocation("300000000000000401", { authorId: UNLISTED_USER }));

  // Assert
  // Events pass the ingress in delivery order, so a later allowed invocation's typing comes after.
  discord.deliver(invocation("300000000000000402", { channelId: OTHER_THREAD }));
  await discord.request("POST", TYPING);
  expect(typingIn(discord)).toStrictEqual([OTHER_THREAD]);
});

it("a failing typing trigger does not affect the reply or Settings", async (c) => {
  // Arrange
  const { discord, factory } = await conversing(c);
  discord.setTypingAvailable(false);

  // Act
  const replies = await answered(discord, "300000000000000403", 1);

  // Assert
  expect(replies).toStrictEqual(["OK"]);
  await discord.request("POST", TYPING);
  const settings = await factory.getDiscordSettings();
  assert(settings.ok);
  expect(settings.value).toMatchObject({ needsAttention: false, connectionProblem: null });
});

it.effect("typing is refreshed within Discord's indicator lifetime while the model works", (c) =>
  Effect.gen(function* () {
    // Arrange
    const { discord, model } = yield* clockedConversation(c);
    model.held();
    discord.deliver(invocation("300000000000000404"));
    yield* until(() => discord.request("POST", TYPING));

    // Act
    yield* TestClock.adjust(REFRESH_MS);

    // Assert
    yield* until(() => discord.request("POST", TYPING, 2));
    expect(typingIn(discord)).toStrictEqual([THREAD, THREAD]);
  }),
);

it.effect("no typing refresh follows a published reply", (c) =>
  Effect.gen(function* () {
    // Arrange
    const { discord, model } = yield* clockedConversation(c);
    yield* until(() => answered(discord, "300000000000000405", 1));
    yield* until(() => discord.request("POST", TYPING));

    // Act
    yield* TestClock.adjust(REFRESH_MS);

    // Assert
    model.held();
    discord.deliver(invocation("300000000000000406", { channelId: OTHER_THREAD }));
    yield* until(() => discord.request("POST", TYPING, 2));
    expect(typingIn(discord)).toStrictEqual([THREAD, OTHER_THREAD]);
  }),
);

it.effect("a reset during interpretation ends typing in the thread before the next refresh", (c) =>
  Effect.gen(function* () {
    // Arrange
    const { discord, model } = yield* clockedConversation(c);
    model.held();
    discord.deliver(invocation("300000000000000407"));
    yield* until(() => discord.request("POST", TYPING));
    discord.deliver(
      resetCommandEvent({
        bot: discordBot,
        guildId: discordGuild.id,
        channel: { id: THREAD, parentId: ALLOWED_CHANNEL, private: false },
        id: "300000000000000408",
      }),
    );
    yield* until(() => discord.request("PATCH", /\/messages\/%40original$/));

    // Act
    yield* TestClock.adjust(REFRESH_MS);

    // Assert
    model.held();
    discord.deliver(invocation("300000000000000409", { channelId: OTHER_THREAD }));
    yield* until(() => discord.request("POST", TYPING, 2));
    expect(typingIn(discord)).toStrictEqual([THREAD, OTHER_THREAD]);
  }),
);

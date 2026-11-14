import { assert, expect, it } from "@effect/vitest";
import {
  messageEvent,
  PARTICIPANT_ID,
  resetCommandEvent,
} from "./support/controlled-discord.ts";
import {
  afterEarlierEvents,
  ALLOWED_CHANNEL,
  chatControlWorld,
  discordBot,
  discordGuild,
  OTHER_CHANNEL,
  POSTS,
  requestsBesides,
  servingAgain,
  THREADS,
  turnedOn,
} from "./support/chat-control.ts";

const SENTINEL = "390000000000000001";
const THREAD = "500000000000000001";
const PRIVATE_THREAD = "500000000000000002";
const OUTSIDER = "200000000000000099";
const ORIGINAL = /^\/api\/v10\/webhooks\/\d+\/[^/]+\/messages\/%40original$/;
const CALLBACK = /^\/api\/v10\/interactions\/\d+\/[^/]+\/callback$/;
const MEMBER_LOOKUP = /^\/api\/v10\/channels\/\d+\/thread-members\/\d+$/;

const invocation = (id: string, overrides: Partial<Parameters<typeof messageEvent>[0]> = {}) =>
  messageEvent({
    bot: discordBot,
    guildId: discordGuild.id,
    channelId: ALLOWED_CHANNEL,
    id,
    ...overrides,
  });

const reset = (id: string, overrides: Partial<Parameters<typeof resetCommandEvent>[0]> = {}) =>
  resetCommandEvent({
    bot: discordBot,
    guildId: discordGuild.id,
    channel: { id: THREAD, parentId: ALLOWED_CHANNEL, private: false },
    id,
    ...overrides,
  });

/** An operating Chat control with a public and a private thread in the allowed channel. */
async function operating(c: Parameters<typeof chatControlWorld>[0]) {
  const world = await chatControlWorld(c);
  world.discord.addThread({
    id: THREAD,
    guildId: discordGuild.id,
    parentId: ALLOWED_CHANNEL,
    name: "work",
    private: false,
    members: [],
  });
  world.discord.addThread({
    id: PRIVATE_THREAD,
    guildId: discordGuild.id,
    parentId: ALLOWED_CHANNEL,
    name: "private work",
    private: true,
    members: [PARTICIPANT_ID],
  });
  await turnedOn(world.factory, world.discord);
  return world;
}

/** The text of the interaction reply Factory edited in, once it arrived. */
async function resetReply(discord: Awaited<ReturnType<typeof operating>>["discord"], count = 1) {
  await discord.request("PATCH", ORIGINAL, count);
  const replies = discord.requested("PATCH", ORIGINAL);
  return (replies[count - 1]!.body as { content: string }).content;
}

it("an allowed participant's mention in an allowed channel opens a public thread on it and is answered there", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000010"));

  // Assert
  await discord.request("POST", POSTS);
  expect(discord.requested("POST", THREADS).map((request) => request.path)).toStrictEqual([
    `/api/v10/channels/${ALLOWED_CHANNEL}/messages/300000000000000010/threads`,
  ]);
  expect(discord.requested("POST", POSTS)).toMatchObject([
    {
      path: "/api/v10/channels/300000000000000010/messages",
      body: { content: expect.stringContaining("Factory received this request") },
    },
  ]);
});

it("an invocation inside a thread of an allowed channel is answered in that thread without a new one", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000011", { channelId: THREAD }));

  // Assert
  await discord.request("POST", POSTS);
  expect(discord.requested("POST", THREADS)).toHaveLength(0);
  expect(discord.requested("POST", POSTS).map((request) => request.path)).toStrictEqual([
    `/api/v10/channels/${THREAD}/messages`,
  ]);
});

it("a reply to the bot invokes it without a mention", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000012", { channelId: THREAD, replyToBot: true }));

  // Assert
  await discord.request("POST", POSTS);
  expect(discord.requested("POST", POSTS).map((request) => request.path)).toStrictEqual([
    `/api/v10/channels/${THREAD}/messages`,
  ]);
});

it("a mention by a user Access does not allow creates no thread and sends Discord nothing", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000013", { authorId: OUTSIDER }));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("a mention in a channel Access does not allow creates no thread and sends Discord nothing", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000014", { channelId: OTHER_CHANNEL }));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("an allowed channel that grants no Project admits nobody", async (c) => {
  // Arrange
  const { discord, factory, project } = await operating(c);
  const saved = await factory.updateDiscordAccess({
    revision: 1,
    users: [PARTICIPANT_ID],
    channels: [
      { channelId: ALLOWED_CHANNEL, projectIds: [project.id] },
      { channelId: OTHER_CHANNEL, projectIds: [] },
    ],
  });
  assert(saved.ok);

  // Act
  discord.deliver(invocation("300000000000000015", { channelId: OTHER_CHANNEL }));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("ordinary messages that neither mention nor reply to the bot are not admitted", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000016", { channelId: THREAD, mention: false }));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("mentions from bots and webhooks are ignored", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(invocation("300000000000000017", { authorIsBot: true }));
  discord.deliver(invocation("300000000000000018", { webhook: true }));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("edits and reactions are not admitted even when they mention the bot", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  const edited = invocation("300000000000000019", { channelId: THREAD });

  // Act
  discord.deliver({ t: "MESSAGE_UPDATE", d: edited.d });
  discord.deliver({
    t: "MESSAGE_REACTION_ADD",
    d: {
      user_id: PARTICIPANT_ID,
      channel_id: THREAD,
      message_id: "300000000000000019",
      guild_id: discordGuild.id,
      emoji: { id: null, name: "👍" },
      type: 0,
      burst: false,
    },
  });

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("removing a participant from Access stops their next invocation as soon as the save returns", async (c) => {
  // Arrange
  const { discord, factory, project } = await operating(c);
  const revoked = await factory.updateDiscordAccess({
    revision: 1,
    users: [OUTSIDER],
    channels: [{ channelId: ALLOWED_CHANNEL, projectIds: [project.id] }],
  });
  assert(revoked.ok);

  // Act
  discord.deliver(invocation("300000000000000020"));

  // Assert
  discord.deliver(invocation(SENTINEL, { authorId: OUTSIDER }));
  await discord.request("POST", new RegExp(`/messages/${SENTINEL}/threads$`));
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([]);
});

it("a repeated delivery of an invocation opens one thread and is answered once", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  discord.deliver(invocation("300000000000000021"));

  // Act
  discord.deliver(invocation("300000000000000021"));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  await discord.request("POST", /^\/api\/v10\/channels\/300000000000000021\/messages$/);
  expect(requestsBesides(discord, SENTINEL)).toStrictEqual([
    `POST /api/v10/channels/${ALLOWED_CHANNEL}/messages/300000000000000021/threads`,
    "GET /api/v10/channels/300000000000000021",
    "POST /api/v10/channels/300000000000000021/messages",
  ]);
});

it("an invocation admitted before a restart is not admitted again when Discord delivers it after the restart", async (c) => {
  // Arrange
  const { discord, factory, open } = await operating(c);
  discord.deliver(invocation("300000000000000022"));
  await discord.request("POST", /^\/api\/v10\/channels\/300000000000000022\/messages$/);
  await factory.close();
  await open();
  await servingAgain(discord, 2);

  // Act
  discord.deliver(invocation("300000000000000022"));

  // Assert
  await afterEarlierEvents(discord, SENTINEL);
  expect(discord.requested("POST", THREADS).map((request) => request.path)).toStrictEqual([
    `/api/v10/channels/${ALLOWED_CHANNEL}/messages/300000000000000022/threads`,
    `/api/v10/channels/${ALLOWED_CHANNEL}/messages/${SENTINEL}/threads`,
  ]);
});

it("an allowed participant's reset in a thread is acknowledged privately and clears the conversation", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(reset("600000000000000001"));

  // Assert
  expect(await resetReply(discord)).toContain("cleared this thread's Chat control conversation");
  expect(discord.requested("POST", CALLBACK)).toMatchObject([
    { body: { type: 5, data: { flags: 64 } } },
  ]);
  expect(discord.requested("POST", POSTS)).toHaveLength(0);
});

it("a reset by a user Access does not allow clears nothing and is answered only to them", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(reset("600000000000000002", { userId: OUTSIDER }));

  // Assert
  expect(await resetReply(discord)).toBe("Chat control does not accept this command from you here.");
});

it("a reset from someone Discord shows cannot view the channel is refused", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(reset("600000000000000003", { permissions: 1n << 11n }));

  // Assert
  expect(await resetReply(discord)).toBe("Chat control does not accept this command from you here.");
});

it("a reset outside a thread explains where it works", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(reset("600000000000000004", { channel: { id: ALLOWED_CHANNEL } }));

  // Assert
  expect(await resetReply(discord)).toBe("Use /factory reset inside a Chat control thread.");
});

it("a repeated delivery of a reset is answered once", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  discord.deliver(reset("600000000000000005"));

  // Act
  discord.deliver(reset("600000000000000005"));

  // Assert
  await resetReply(discord);
  discord.deliver(reset("600000000000000006"));
  await resetReply(discord, 2);
  expect(discord.requested("POST", CALLBACK).map((request) => request.path)).toStrictEqual([
    "/api/v10/interactions/600000000000000005/interaction-token-600000000000000005/callback",
    "/api/v10/interactions/600000000000000006/interaction-token-600000000000000006/callback",
  ]);
});

it("a reset in a private thread the requester belongs to is accepted after Discord confirms the membership", async (c) => {
  // Arrange
  const { discord } = await operating(c);

  // Act
  discord.deliver(
    reset("600000000000000007", {
      channel: { id: PRIVATE_THREAD, parentId: ALLOWED_CHANNEL, private: true },
    }),
  );

  // Assert
  expect(await resetReply(discord)).toContain("cleared");
  expect(discord.requested("GET", MEMBER_LOOKUP).map((request) => request.path)).toStrictEqual([
    `/api/v10/channels/${PRIVATE_THREAD}/thread-members/${PARTICIPANT_ID}`,
  ]);
});

it("a reset in a private thread the requester does not belong to is refused", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  discord.removeThreadMember(PRIVATE_THREAD, PARTICIPANT_ID);

  // Act
  discord.deliver(
    reset("600000000000000008", {
      channel: { id: PRIVATE_THREAD, parentId: ALLOWED_CHANNEL, private: true },
    }),
  );

  // Assert
  expect(await resetReply(discord)).toBe("Chat control does not accept this command from you here.");
});

it("a reset in a private thread is refused when Discord cannot confirm the membership", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  discord.setThreadMembersAvailable(false);

  // Act
  discord.deliver(
    reset("600000000000000009", {
      channel: { id: PRIVATE_THREAD, parentId: ALLOWED_CHANNEL, private: true },
    }),
  );

  // Assert
  expect(await resetReply(discord)).toContain("could not confirm your access");
});

it("posting in a private thread is membership evidence for a later reset there", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  discord.deliver(invocation("300000000000000023", { channelId: PRIVATE_THREAD }));
  await discord.request("POST", POSTS);

  // Act
  discord.deliver(
    reset("600000000000000010", {
      channel: { id: PRIVATE_THREAD, parentId: ALLOWED_CHANNEL, private: true },
    }),
  );

  // Assert
  expect(await resetReply(discord)).toContain("cleared");
  expect(discord.requested("GET", MEMBER_LOOKUP)).toHaveLength(0);
});

it("a membership removal Discord announces invalidates remembered private-thread evidence", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  const privateReset = (id: string) =>
    reset(id, { channel: { id: PRIVATE_THREAD, parentId: ALLOWED_CHANNEL, private: true } });
  discord.deliver(privateReset("600000000000000011"));
  await resetReply(discord);
  discord.removeThreadMember(PRIVATE_THREAD, PARTICIPANT_ID, true);

  // Act
  discord.deliver(privateReset("600000000000000012"));

  // Assert
  expect(await resetReply(discord, 2)).toBe(
    "Chat control does not accept this command from you here.",
  );
});

it("a connection gap forgets private-thread evidence, so a membership lost meanwhile is noticed", async (c) => {
  // Arrange
  const { discord } = await operating(c);
  const privateReset = (id: string) =>
    reset(id, { channel: { id: PRIVATE_THREAD, parentId: ALLOWED_CHANNEL, private: true } });
  discord.deliver(privateReset("600000000000000013"));
  await resetReply(discord);
  discord.removeThreadMember(PRIVATE_THREAD, PARTICIPANT_ID);
  discord.interruptSessions();
  await discord.readied(2);

  // Act
  discord.deliver(privateReset("600000000000000014"));

  // Assert
  expect(await resetReply(discord, 2)).toBe(
    "Chat control does not accept this command from you here.",
  );
  expect(discord.requested("GET", MEMBER_LOOKUP)).toHaveLength(2);
});

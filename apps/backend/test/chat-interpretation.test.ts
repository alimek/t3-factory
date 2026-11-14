import { assert, expect, it } from "@effect/vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { PARTICIPANT_ID, resetCommandEvent } from "./support/controlled-discord.ts";
import {
  ALLOWED_CHANNEL,
  chatModelSave,
  discordBot,
  discordGuild,
  servingAgain,
} from "./support/chat-control.ts";
import {
  answered,
  clockedConversation,
  COLLABORATOR_ID,
  conversing,
  invocation,
  OTHER_THREAD,
  posted,
  savedAccess,
  THREAD,
  until,
  userEnvelopes,
} from "./support/chat-conversation.ts";

const HOUR_MS = 60 * 60 * 1000;
const MENTION = `<@${discordBot.applicationId}>`;
const NOTICES = {
  failed:
    "Factory's language model could not answer a request in this thread. Nothing from it was kept; send it again later.",
  timedOut:
    "Factory stopped a request in this thread because it took too long. Nothing from it was kept; send it again if you still need it.",
  interrupted:
    "Factory could not finish a request in this thread because it was interrupted. Nothing from it was kept; send it again if you still need it.",
  cleared: "_Earlier conversation in this thread was cleared; Factory no longer has it._",
};
const BUSY =
  "Factory is already working on four requests in this thread: one is being answered and three are waiting. This message was not taken; send it again after Factory replies.";
const STEPS =
  "Factory stopped this request because answering it needed more than 8 model requests or 16 tool calls. Nothing from it was kept; ask a narrower question.";
const listProjects = { toolCalls: [{ name: "list_projects", input: {} }] };

it("a request over 8,000 characters is refused without a model request", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);

  // Act
  const replies = await answered(discord, "300000000000000200", 1, { content: "x".repeat(8000) });

  // Assert
  expect(replies[0]).toContain("longer than Chat control accepts (8,000 characters and 16 KiB)");
  expect(model.requests).toHaveLength(0);
});

it("a request over 16 KiB is refused even within 8,000 characters", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);

  // Act
  const replies = await answered(discord, "300000000000000201", 1, {
    content: "😀".repeat(4100),
  });

  // Assert
  expect(replies[0]).toContain("longer than Chat control accepts (8,000 characters and 16 KiB)");
  expect(model.requests).toHaveLength(0);
});

it("input and instructions that cannot fit in one 64 KiB model request are refused, never cut", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);

  // Act
  const replies = await answered(discord, "300000000000000202", 1, {
    content: "\u0001".repeat(7900),
    replyTo: {
      id: "300000000000000002",
      channelId: THREAD,
      authorId: COLLABORATOR_ID,
      content: "\u0001".repeat(7900),
    },
  });

  // Assert
  expect(replies[0]).toContain("do not fit within Chat control's 64 KiB model request limit");
  expect(model.requests).toHaveLength(0);
});

it("an interpretation that would need a ninth model request is stopped with an explanation", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  model.script(...Array.from({ length: 9 }, () => listProjects));

  // Act
  const replies = await answered(discord, "300000000000000203", 1);

  // Assert
  expect(replies).toStrictEqual([STEPS]);
  expect(model.requests).toHaveLength(8);
});

it("a model answer asking for more than 16 tool calls is stopped before any of them runs", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  model.script({ toolCalls: Array.from({ length: 17 }, () => listProjects.toolCalls[0]!) });

  // Act
  const replies = await answered(discord, "300000000000000204", 1);

  // Assert
  expect(replies).toStrictEqual([STEPS]);
  expect(model.requests).toHaveLength(1);
});

it("an actual conversational failure sets the Language model runtime problem and tells the thread to resend", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  model.script({ status: 500, body: { error: "secret upstream detail" } });

  // Act
  const replies = await answered(discord, "300000000000000205", 1);

  // Assert
  expect(replies).toStrictEqual([NOTICES.failed]);
  const settings = await factory.getChatModelSettings();
  assert(settings.ok);
  expect(settings.value).toMatchObject({
    runtimeProblem: { revision: 1, message: "The provider answered HTTP 500." },
    needsAttention: true,
  });
});

it("a later successful conversation clears the runtime problem", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  model.script({ status: 503, body: {} });
  await answered(discord, "300000000000000206", 1);

  // Act
  await answered(discord, "300000000000000207", 2);

  // Assert
  const settings = await factory.getChatModelSettings();
  assert(settings.ok);
  expect(settings.value).toMatchObject({ runtimeProblem: null, needsAttention: false });
});

it("a successful synthetic Test is dated evidence and leaves the runtime problem in place", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  model.script({ status: 500, body: {} });
  await answered(discord, "300000000000000208", 1);

  // Act
  const tested = await factory.testChatModel({ revision: 1 });

  // Assert
  assert(tested.ok);
  expect(tested.value.latestTest).toMatchObject({ outcome: "succeeded" });
  expect(tested.value.runtimeProblem).toMatchObject({ message: "The provider answered HTTP 500." });
});

it("a model failure also discards the invocations queued behind it, with one notice for the thread", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  const first = model.held();
  discord.deliver(invocation("300000000000000209"));
  await model.requested(1);
  discord.deliver(invocation("300000000000000210", { authorId: COLLABORATOR_ID }));

  // Act
  first.release({ status: 500, body: {} });

  // Assert
  await posted(discord, 1);
  const replies = await answered(discord, "300000000000000211", 2);
  expect(replies).toStrictEqual([NOTICES.failed, "OK"]);
  expect(model.requests).toHaveLength(2);
});

it("a fifth admitted message while one is answered and three wait gets deterministic busy feedback", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  model.held();
  discord.deliver(invocation("300000000000000212"));
  await model.requested(1);
  discord.deliver(invocation("300000000000000213"));
  discord.deliver(invocation("300000000000000214"));
  discord.deliver(invocation("300000000000000215"));

  // Act
  discord.deliver(invocation("300000000000000216"));

  // Assert
  expect(await posted(discord, 1)).toStrictEqual([BUSY]);
  expect(model.requests).toHaveLength(1);
});

it("queued invocations are answered one at a time in admission order, each with only its own requester", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  const first = model.held();
  discord.deliver(invocation("300000000000000217", { content: "first" }));
  await model.requested(1);
  discord.deliver(
    invocation("300000000000000218", { authorId: COLLABORATOR_ID, content: "second" }),
  );
  discord.deliver(invocation("300000000000000219", { content: "third" }));

  // Act
  first.release({ text: "one" });

  // Assert
  await posted(discord, 3);
  expect(userEnvelopes(model, 1).at(-1)).toStrictEqual({
    from: `discord-user:${COLLABORATOR_ID}`,
    message: `${MENTION} second`,
  });
  expect(userEnvelopes(model, 2).map((envelope) => envelope.message)).toStrictEqual([
    `${MENTION} first`,
    `${MENTION} second`,
    `${MENTION} third`,
  ]);
});

it("a model save discards the unfinished interpretation: its late answer is never published and the thread is told to resend", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  const late = model.held();
  discord.deliver(invocation("300000000000000220"));
  await model.requested(1);

  // Act
  const saved = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: model.baseUrl(), model: "model-b" }),
  );

  // Assert
  assert(saved.ok);
  late.release({ text: "late answer" });
  const replies = await answered(discord, "300000000000000221", 2);
  expect(replies).toStrictEqual([NOTICES.interrupted, "OK"]);
  expect(userEnvelopes(model, 1).map((envelope) => envelope.message)).toStrictEqual([
    `${MENTION} list my Projects`,
  ]);
});

it("changing only the model name keeps the shared conversation", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  await answered(discord, "300000000000000222", 1, { content: "remember me" });
  const saved = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: model.baseUrl(), model: "model-b" }),
  );
  assert(saved.ok);

  // Act
  await answered(discord, "300000000000000223", 2);

  // Assert
  expect(userEnvelopes(model, 1).map((envelope) => envelope.message)).toStrictEqual([
    `${MENTION} remember me`,
    `${MENTION} list my Projects`,
  ]);
});

it("changing the base URL clears the conversation and the next reply says so", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  await answered(discord, "300000000000000224", 1, { content: "remember me" });
  const saved = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: model.baseUrl("/proxy/v1") }),
  );
  assert(saved.ok);

  // Act
  const replies = await answered(discord, "300000000000000225", 2);

  // Assert
  expect(userEnvelopes(model, 1)).toHaveLength(1);
  expect(replies[1]).toBe(`${NOTICES.cleared}\n\nOK`);
});

it("narrowing a channel's Projects clears its whole conversation and a regrant restores nothing", async (c) => {
  // Arrange
  const { discord, model, factory, harness, project } = await conversing(c);
  const otherRoot = join(harness.processHome, "other");
  await mkdir(otherRoot);
  const other = await factory.addRepository({ path: otherRoot });
  assert(other.ok);
  await savedAccess(factory, [PARTICIPANT_ID], [project.id, other.value.id]);
  await answered(discord, "300000000000000226", 1, { content: "about both" });
  await savedAccess(factory, [PARTICIPANT_ID], [project.id]);

  // Act
  await savedAccess(factory, [PARTICIPANT_ID], [project.id, other.value.id]);
  const replies = await answered(discord, "300000000000000227", 2);

  // Assert
  expect(userEnvelopes(model, 1)).toHaveLength(1);
  expect(replies[1]).toBe(`${NOTICES.cleared}\n\nOK`);
});

it("expanding a channel's Projects keeps its conversation", async (c) => {
  // Arrange
  const { discord, model, factory, harness, project } = await conversing(c);
  const otherRoot = join(harness.processHome, "other");
  await mkdir(otherRoot);
  const other = await factory.addRepository({ path: otherRoot });
  assert(other.ok);
  await answered(discord, "300000000000000228", 1, { content: "remember me" });

  // Act
  await savedAccess(factory, [PARTICIPANT_ID], [project.id, other.value.id]);
  await answered(discord, "300000000000000229", 2);

  // Assert
  expect(userEnvelopes(model, 1)).toHaveLength(2);
});

it("removing a user keeps their committed contributions for the remaining participants", async (c) => {
  // Arrange
  const { discord, model, factory, project } = await conversing(c);
  await answered(discord, "300000000000000230", 1, { content: "shared context" });
  await savedAccess(factory, [COLLABORATOR_ID], [project.id]);

  // Act
  await answered(discord, "300000000000000231", 2, { authorId: COLLABORATOR_ID });

  // Assert
  expect(userEnvelopes(model, 1).map((envelope) => envelope.from)).toStrictEqual([
    `discord-user:${PARTICIPANT_ID}`,
    `discord-user:${COLLABORATOR_ID}`,
  ]);
});

it("removing a user stops their unfinished interpretation before it publishes", async (c) => {
  // Arrange
  const { discord, model, factory, project } = await conversing(c);
  const late = model.held();
  discord.deliver(invocation("300000000000000232"));
  await model.requested(1);
  await savedAccess(factory, [COLLABORATOR_ID], [project.id]);

  // Act
  late.release({ text: "for a removed user" });

  // Assert
  const replies = await answered(discord, "300000000000000233", 1, { authorId: COLLABORATOR_ID });
  expect(replies).toStrictEqual(["OK"]);
  expect(userEnvelopes(model, 1)).toHaveLength(1);
});

it("a reset during interpretation fences its late reply and keeps nothing of it", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  const late = model.held();
  discord.deliver(invocation("300000000000000234"));
  await model.requested(1);
  discord.deliver(
    resetCommandEvent({
      bot: discordBot,
      guildId: discordGuild.id,
      channel: { id: THREAD, parentId: ALLOWED_CHANNEL, private: false },
      id: "300000000000000235",
    }),
  );
  await discord.request("PATCH", /\/messages\/%40original$/);

  // Act
  late.release({ text: "from before the reset" });

  // Assert
  const replies = await answered(discord, "300000000000000236", 1);
  expect(replies).toStrictEqual(["OK"]);
  expect(userEnvelopes(model, 1)).toHaveLength(1);
});

it("Off discards unfinished work without a notice, and turning On again revives none", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  const late = model.held();
  discord.deliver(invocation("300000000000000237"));
  await model.requested(1);
  await factory.setChatControlEnabled({ enabled: false });

  // Act
  await factory.setChatControlEnabled({ enabled: true });
  await servingAgain(discord, 2);

  // Assert
  late.release({ text: "after Off" });
  const replies = await answered(discord, "300000000000000238", 1);
  expect(replies).toStrictEqual(["OK"]);
});

it("a restart discards unfinished work without replaying it and tells the thread once to resend", async (c) => {
  // Arrange
  const { discord, model, factory, open } = await conversing(c);
  model.held();
  discord.deliver(invocation("300000000000000239"));
  await model.requested(1);
  await factory.close();

  // Act
  await open();
  await servingAgain(discord, 2);

  // Assert
  expect(await posted(discord, 1)).toStrictEqual([NOTICES.interrupted]);
  expect(model.requests).toHaveLength(1);
});

it("connecting another application and back revives no conversation", async (c) => {
  // Arrange
  const { discord, model, factory } = await conversing(c);
  const other = { token: "other-bot-token.discord.secret", applicationId: "123456789012345679" };
  discord.addBot(other);
  await answered(discord, "300000000000000240", 1, { content: "old identity" });
  await factory.setChatControlEnabled({ enabled: false });
  const away = await factory.updateDiscordConnection({
    revision: 1,
    applicationId: other.applicationId,
    publicKey: "b".repeat(64),
    token: { kind: "replace", value: other.token },
    applicationChangeConfirmed: true,
  });
  assert(away.ok, JSON.stringify(away));
  const back = await factory.updateDiscordConnection({
    revision: 2,
    applicationId: discordBot.applicationId,
    publicKey: "a".repeat(64),
    token: { kind: "replace", value: discordBot.token },
    applicationChangeConfirmed: true,
  });
  assert(back.ok, JSON.stringify(back));
  await factory.setChatControlEnabled({ enabled: true });
  await servingAgain(discord, 2);

  // Act
  await answered(discord, "300000000000000241", 2);

  // Assert
  expect(userEnvelopes(model, 1)).toHaveLength(1);
});

it("output finished during a transport-only outage is published after the connection resumes", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  const held = model.held();
  discord.deliver(invocation("300000000000000242"));
  await model.requested(1);
  discord.holdResume();
  discord.interruptSessions();
  await discord.resumeAttempted(1);
  held.release({ text: "held reply" });

  // Act
  discord.releaseResume();

  // Assert
  expect(await posted(discord, 1)).toStrictEqual(["held reply"]);
  expect(discord.requested("GET", /\/guilds\/\d+\/members\/\d+$/)).toHaveLength(1);
});

it("held output is discarded when the requester lost access during the outage", async (c) => {
  // Arrange
  const { discord, model } = await conversing(c);
  const held = model.held();
  discord.deliver(invocation("300000000000000243"));
  await model.requested(1);
  discord.holdResume();
  discord.interruptSessions();
  await discord.resumeAttempted(1);
  held.release({ text: "for someone who left" });
  discord.removeGuildMember(PARTICIPANT_ID);

  // Act
  discord.releaseResume();

  // Assert
  const replies = await answered(discord, "300000000000000244", 1, { authorId: COLLABORATOR_ID });
  expect(replies).toStrictEqual(["OK"]);
});

it.effect(
  "a model request unanswered for 60 seconds is a runtime failure and the thread is told to resend",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { discord, model, factory } = yield* clockedConversation(c);
      model.script({ hang: true });
      discord.deliver(invocation("300000000000000245"));
      yield* until(() => model.requested(1));

      // Act
      yield* TestClock.adjust(60_000);

      // Assert
      expect(yield* until(() => posted(discord, 1))).toStrictEqual([NOTICES.failed]);
      const settings = yield* factory.getChatModelSettings();
      assert(settings.ok);
      expect(settings.value.runtimeProblem).toMatchObject({
        message: "The provider did not answer within 60 seconds.",
      });
    }),
);

it.effect(
  "the 180-second interpretation budget stops a slow tool loop without blaming the provider",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { discord, model, factory } = yield* clockedConversation(c);
      const first = model.held();
      const second = model.held();
      const third = model.held();
      model.script({ hang: true });
      discord.deliver(invocation("300000000000000246"));
      yield* until(() => model.requested(1));
      yield* TestClock.adjust(59_000);
      first.release(listProjects);
      yield* until(() => model.requested(2));
      yield* TestClock.adjust(59_000);
      second.release(listProjects);
      yield* until(() => model.requested(3));
      yield* TestClock.adjust(59_000);
      third.release(listProjects);
      yield* until(() => model.requested(4));

      // Act
      yield* TestClock.adjust(3_000);

      // Assert
      expect(yield* until(() => posted(discord, 1))).toStrictEqual([NOTICES.timedOut]);
      const settings = yield* factory.getChatModelSettings();
      assert(settings.ok);
      expect(settings.value.runtimeProblem).toBeNull();
    }),
);

it.effect(
  "the five-minute recovery timeout from the first model dispatch ends work held by an outage",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { discord, model } = yield* clockedConversation(c);
      const held = model.held();
      discord.deliver(invocation("300000000000000247"));
      yield* until(() => model.requested(1));
      yield* TestClock.adjust(10_000);
      discord.holdResume();
      discord.interruptSessions();
      yield* until(() => discord.resumeAttempted(1));
      held.release({ text: "too late" });

      // Act
      yield* TestClock.adjust(295_000);

      // Assert
      discord.releaseResume();
      expect(yield* until(() => posted(discord, 1))).toStrictEqual([NOTICES.timedOut]);
    }),
);

it.effect(
  "a queued invocation still waiting when its five minutes pass is never dispatched and its thread is told once",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { discord, model } = yield* clockedConversation(c);
      const held = model.held();
      discord.deliver(invocation("300000000000000248"));
      yield* until(() => model.requested(1));
      discord.deliver(invocation("300000000000000249", { authorId: COLLABORATOR_ID }));
      yield* until(() => answered(discord, "300000000000000250", 1, { channelId: OTHER_THREAD }));
      discord.holdResume();
      discord.interruptSessions();
      yield* until(() => discord.resumeAttempted(1));
      held.release({ text: "first reply" });

      // Act
      yield* TestClock.adjust(300_000);

      // Assert
      discord.releaseResume();
      expect((yield* until(() => posted(discord, 2))).slice(1)).toStrictEqual([NOTICES.timedOut]);
      expect(model.requests).toHaveLength(2);
    }),
);

it.effect(
  "work discarded during an outage gets no resend notice more than fifteen minutes after admission",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { discord, model } = yield* clockedConversation(c);
      const held = model.held();
      discord.deliver(invocation("300000000000000251"));
      yield* until(() => model.requested(1));
      discord.holdResume();
      discord.interruptSessions();
      yield* until(() => discord.resumeAttempted(1));
      held.release({ text: "too late" });
      yield* TestClock.adjust(300_000);

      // Act
      yield* TestClock.adjust(601_000);
      discord.releaseResume();

      // Assert
      expect(yield* until(() => answered(discord, "300000000000000252", 1))).toStrictEqual(["OK"]);
    }),
);

it.effect(
  "72 hours without an admitted invocation clear the conversation and the next reply says so",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const { discord, model } = yield* clockedConversation(c);
      yield* until(() => answered(discord, "300000000000000253", 1, { content: "old" }));
      yield* TestClock.adjust(72 * HOUR_MS);

      // Act
      const replies = yield* until(() => answered(discord, "300000000000000254", 2));

      // Assert
      expect(userEnvelopes(model, 1)).toHaveLength(1);
      expect(replies[1]).toBe(`${NOTICES.cleared}\n\nOK`);
    }),
);

it.effect("a conversation generation is cleared after 14 days however active it is", (c) =>
  Effect.gen(function* () {
    // Arrange
    const { discord, model } = yield* clockedConversation(c);
    yield* until(() => answered(discord, "300000000000000255", 1));
    yield* TestClock.adjust(71 * HOUR_MS);
    yield* until(() => answered(discord, "300000000000000256", 2));
    yield* TestClock.adjust(71 * HOUR_MS);
    yield* until(() => answered(discord, "300000000000000257", 3));
    yield* TestClock.adjust(71 * HOUR_MS);
    yield* until(() => answered(discord, "300000000000000258", 4));
    yield* TestClock.adjust(71 * HOUR_MS);
    yield* until(() => answered(discord, "300000000000000259", 5));
    yield* TestClock.adjust(52 * HOUR_MS);

    // Act
    const replies = yield* until(() => answered(discord, "300000000000000260", 6));

    // Assert
    expect(userEnvelopes(model, 4)).toHaveLength(5);
    expect(userEnvelopes(model, 5)).toHaveLength(1);
    expect(replies[5]).toBe(`${NOTICES.cleared}\n\nOK`);
  }),
);

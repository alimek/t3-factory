import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  besidesReports,
  buttonShown,
  clicked,
  clockedStartingWorld,
  createdBesidesReports,
  confirmations,
  clickAnswers,
  isStatusCard,
  proposedStart,
  runsOf,
  START_PROMPT,
  startCall,
  startingWorld,
  statusCardsIn,
} from "./support/chat-actions.ts";
import {
  ALLOWED_CHANNEL,
  discordBot,
  discordConnectionSave,
  discordSettingsWhen,
  servingAgain,
  turnedOn,
} from "./support/chat-control.ts";
import {
  COLLABORATOR_ID,
  invocation,
  savedAccess,
  THREAD,
  toolResults,
  until,
} from "./support/chat-conversation.ts";
import { addedProject } from "./support/chat-runs.ts";
import { PARTICIPANT_ID, unproven } from "./support/controlled-discord.ts";

/** Clicks that decided the review answer with its disabled button; others privately. */
const ANSWERS = {
  accepted: "✅ Confirmed (disabled)",
  notYours:
    "🔒 Only the person who asked for this review can confirm it. Ask Factory for your own.",
  invalid: "🚫 This confirmation is no longer valid. Ask Factory for a new review.",
  expired: "⌛ This review expired, so nothing was done. Ask Factory for a new review.",
  denied: "🚫 Chat control does not accept this confirmation from you here.",
  rejected: "🚫 No longer valid (disabled)",
} as const;

const MESSAGE_CREATES = /^\/api\/v10\/channels\/\d+\/messages$/;

it("a Start proposal posts Factory's complete compact review with one requester button last, and starts nothing", async (c) => {
  // Arrange
  const world = await startingWorld(c);

  // Act
  const button = await proposedStart(world, "600000000000000001", 2);

  // Assert
  const [review, confirmation] = world.discord.created;
  expect(review!.content).toBe(
    [
      "📝 **Start a Run?**",
      `📁 ${world.project.title} · \`${world.project.workspaceRoot}\``,
      `🔀 ${world.flow.name} · in the Project's checkout`,
      "🏷️ Improve search",
      `\`\`\`\n${START_PROMPT}\n\`\`\``,
      "ℹ️ The current saved Flow and Agent definitions, workspace included, apply when you confirm; Factory checks again and may still refuse.",
    ].join("\n"),
  );
  expect(confirmation!.content).toMatch(
    /^🔒 Only the person who asked can confirm · expires <t:\d+:R>$/,
  );
  expect(confirmations(world.discord)).toHaveLength(1);
  expect(button).toMatch(/^factory-confirm:/);
  expect(await runsOf(world.factory)).toStrictEqual([]);
});

it("the requester's confirmation accepts exactly the reviewed Start, posts the deterministic receipt and makes the thread the Run's originating thread", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(buttonShown(world.discord, button)).toBe("✅ Confirmed (disabled)");
  expect(world.discord.interactionAnswers.map((entry) => entry.kind)).toStrictEqual(["updated"]);
  await createdBesidesReports(world.discord, 3);
  const navigation = await world.factory.listRunNavigation();
  assert(navigation.ok);
  const [run] = navigation.value;
  const detail = await world.factory.getRun(run!.id);
  assert(detail.ok);
  expect(detail.value.input).toBe(START_PROMPT);
  expect(detail.value.title).toBe("Improve search");
  expect(detail.value.titleProvenance).toBe("automatic");
  expect(besidesReports(world.discord)[2]!.content).toBe(
    `✅ **Run #1 started** — Improve search\n📁 ${world.project.title} · 🔀 ${world.flow.name}`,
  );
  await world.discord.createdWhere(isStatusCard, 1);
  expect(statusCardsIn(world.discord).map((card) => card.channelId)).toStrictEqual([THREAD]);
});

it("another participant's click is refused ephemerally and leaves the requester's consent usable", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  await clicked(world.discord, button, "610000000000000001", 1, { userId: COLLABORATOR_ID });

  // Act
  const answer = await clicked(world.discord, button, "610000000000000002", 2);

  // Assert
  expect(clickAnswers(world.discord)).toStrictEqual([ANSWERS.notYours, ANSWERS.accepted]);
  expect(answer).toBe(ANSWERS.accepted);
  expect(await runsOf(world.factory)).toStrictEqual([{ number: 1, title: "Improve search" }]);
});

it("another participant's click is answered privately and leaves the requester's button as it is", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1, {
    userId: COLLABORATOR_ID,
  });

  // Assert
  expect(answer).toBe(ANSWERS.notYours);
  expect(buttonShown(world.discord, button)).toBe("Confirm Start");
  expect(world.discord.componentEdits).toStrictEqual([]);
});

it("a repeated click after acceptance starts no second Run and tells the requester the accepted result without a public receipt", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  await clicked(world.discord, button, "610000000000000001", 1);
  await createdBesidesReports(world.discord, 3);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000002", 2);

  // Assert
  expect(answer).toBe(
    "You already confirmed this review. Factory accepted Run #1 “Improve search”.",
  );
  expect(await runsOf(world.factory)).toHaveLength(1);
  expect(besidesReports(world.discord)).toHaveLength(3);
});

it("two clicks racing on one review start exactly one Run", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);

  // Act
  const [first, second] = await Promise.all([
    clicked(world.discord, button, "610000000000000001", 1),
    clicked(world.discord, button, "610000000000000002", 2),
  ]);

  // Assert
  expect([first, second]).toContain(ANSWERS.accepted);
  expect(await runsOf(world.factory)).toStrictEqual([{ number: 1, title: "Improve search" }]);
});

it("an identical proposal by the same requester reuses the waiting review and posts no second button", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  await proposedStart(world, "600000000000000001", 2);
  world.model.script(startCall(world, START_PROMPT));

  // Act
  world.discord.deliver(
    invocation("600000000000000002", { content: `start this:\n${START_PROMPT}` }),
  );

  // Assert
  await createdBesidesReports(world.discord, 3);
  expect(besidesReports(world.discord)[2]!.content).toContain(
    "This exact Start already has a review waiting for your confirmation in this thread.",
  );
  expect(confirmations(world.discord)).toHaveLength(1);
});

it("a corrected Start for the same Project supersedes the earlier review without the model naming it, so its button starts nothing", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const first = await proposedStart(world, "600000000000000001", 2);
  await proposedStart(
    world,
    "600000000000000002",
    4,
    startCall(world, "Improve search filters"),
    "no, start: Improve search filters",
  );

  // Act
  const answer = await clicked(world.discord, first, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.invalid);
  expect(await runsOf(world.factory)).toStrictEqual([]);
});

it("a corrected Start shows the earlier review's button as replaced", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const first = await proposedStart(world, "600000000000000001", 2);

  // Act
  await proposedStart(
    world,
    "600000000000000002",
    4,
    startCall(world, "Improve search filters"),
    "no, start: Improve search filters",
  );

  // Assert
  await world.discord.componentsEdited(1);
  expect(buttonShown(world.discord, first)).toBe("↩️ Replaced (disabled)");
  expect(confirmations(world.discord)).toHaveLength(2);
});

it("a Start proposed for another Project leaves the earlier Start's review confirmable", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const other = await addedProject(world, "other-clone");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);
  const first = await proposedStart(world, "600000000000000001", 2);
  await proposedStart(
    world,
    "600000000000000002",
    4,
    startCall(world, "Improve search filters", { projectId: other.id }),
    "also start: Improve search filters",
  );

  // Act
  const answer = await clicked(world.discord, first, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(await runsOf(world.factory)).toStrictEqual([{ number: 1, title: "Improve search" }]);
});

it("a prompt that is not exact text from the requester's message gets no review, and the model is told to copy it exactly", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  world.model.script(startCall(world, "Improve the search page"), { text: "Which exact text?" });

  // Act
  world.discord.deliver(
    invocation("600000000000000001", { content: `start this:\n${START_PROMPT}` }),
  );

  // Assert
  await world.discord.createdMessages(1);
  expect(world.discord.created.map((message) => message.content)).toStrictEqual([
    "Which exact text?",
  ]);
  expect(toolResults(world.model, 1)).toStrictEqual([
    {
      error: "prompt_not_exact",
      message:
        "The prompt is not exact text from the requester's message. Copy it character for character, or mark it composed so Factory labels it.",
    },
  ]);
});

it("a composed prompt is reviewed in full and labelled as written by Factory's assistant", async (c) => {
  // Arrange
  const world = await startingWorld(c);

  // Act
  await proposedStart(
    world,
    "600000000000000001",
    2,
    startCall(world, "Fix the flaky login test", { promptSource: "composed" }),
    "can you get the login test fixed?",
  );

  // Assert
  expect(world.discord.created[0]!.content).toContain(
    "⚠️ Prompt **composed by Factory's assistant, not written by you** — read all of it:\n```\nFix the flaky login test\n```",
  );
});

it("task text over 8,000 characters is refused without a review, never shortened", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  world.model.script(startCall(world, "x".repeat(8001), { promptSource: "composed" }), {
    text: "Too long.",
  });

  // Act
  world.discord.deliver(invocation("600000000000000001", { content: "start a long task" }));

  // Assert
  await world.discord.createdMessages(1);
  expect(confirmations(world.discord)).toHaveLength(0);
  expect(toolResults(world.model, 1)[0]!.error).toBe("prompt_too_long");
});

it.effect("a click after the review's five-minute lifetime starts nothing", (c) =>
  Effect.gen(function* () {
    // Arrange
    const world = yield* clockedStartingWorld(c);
    const button = yield* until(() => proposedStart(world, "600000000000000001", 2));
    yield* TestClock.adjust(5 * 60_000);

    // Act
    const answer = yield* until(() => clicked(world.discord, button, "610000000000000001", 1));

    // Assert
    expect(answer).toBe(ANSWERS.expired);
    const navigation = yield* world.factory.listRunNavigation();
    assert(navigation.ok);
    expect(navigation.value).toStrictEqual([]);
  }),
);

it.effect("a review's button shows as expired at its original expiry", (c) =>
  Effect.gen(function* () {
    // Arrange
    const world = yield* clockedStartingWorld(c);
    const button = yield* until(() => proposedStart(world, "600000000000000001", 2));

    // Act
    yield* TestClock.adjust(5 * 60_000);

    // Assert
    yield* until(() => world.discord.componentsEdited(1));
    expect(buttonShown(world.discord, button)).toBe("⌛ Expired (disabled)");
  }),
);

it("a Discord access denial rejects the click without consuming the consent", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  await clicked(world.discord, button, "610000000000000001", 1, { permissions: 0n });

  // Act
  const answer = await clicked(world.discord, button, "610000000000000002", 2);

  // Assert
  expect(clickAnswers(world.discord)).toStrictEqual([ANSWERS.denied, ANSWERS.accepted]);
  expect(answer).toBe(ANSWERS.accepted);
  expect(await runsOf(world.factory)).toHaveLength(1);
});

it("revoking the requester voids their waiting review for good, even after the grant returns", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id]);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.invalid);
  expect(await runsOf(world.factory)).toStrictEqual([]);
});

it("revoking the requester shows their waiting review's button as no longer valid", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);

  // Act
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);

  // Assert
  await world.discord.componentsEdited(1);
  expect(buttonShown(world.discord, button)).toBe("🚫 No longer valid (disabled)");
});

it("a review voided while Chat control is Off keeps its button as it is after turning On again", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const voidedWhileOff = await proposedStart(world, "600000000000000001", 2);
  world.model.script(startCall(world, START_PROMPT));
  world.discord.deliver(
    invocation("600000000000000002", {
      content: `start this:\n${START_PROMPT}`,
      authorId: COLLABORATOR_ID,
    }),
  );
  await world.discord.createdMessages(4);
  const voidedWhileOn = confirmations(world.discord)[1]!;
  assert((await world.factory.setChatControlEnabled({ enabled: false })).ok);
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);
  await turnedOn(world.factory, world.discord, 2);

  // Act
  await savedAccess(world.factory, [], [world.project.id]);

  // Assert
  await world.discord.componentsEdited(1);
  expect(world.discord.componentEdits.map((edit) => edit.messageId)).toStrictEqual([
    voidedWhileOn.id,
  ]);
  expect(buttonShown(world.discord, voidedWhileOff)).toBe("Confirm Start");
});

it("revoking the requester while their review is being posted stops it before its button appears", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  world.discord.faultMessages("paused");
  world.model.script(startCall(world, START_PROMPT));
  world.discord.deliver(
    invocation("600000000000000001", { content: `start this:\n${START_PROMPT}` }),
  );
  await world.discord.request("POST", MESSAGE_CREATES, 1);
  // A collaborator's message in the same thread is interpreted only after the review ends.
  world.discord.deliver(invocation("600000000000000002", { authorId: COLLABORATOR_ID }));
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);

  // Act
  world.discord.releaseMessages();

  // Assert
  await world.discord.createdMessages(2);
  expect(world.discord.created.map((message) => message.content)).toStrictEqual([
    expect.stringContaining(`🔀 ${world.flow.name}`),
    "OK",
  ]);
  expect(confirmations(world.discord)).toStrictEqual([]);
});

it("replacing the Discord application retires its waiting reviews, even after switching back", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  const other = { token: "other-bot-token.discord.secret", applicationId: "123456789012345679" };
  world.discord.addBot(other);
  const replaced = await world.factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "replace", value: other.token } }),
  );
  assert(replaced.ok, JSON.stringify(replaced));
  await servingAgain(world.discord, 2);
  const restored = await world.factory.updateDiscordConnection(
    discordConnectionSave({ revision: 2 }),
  );
  assert(restored.ok, JSON.stringify(restored));
  await servingAgain(world.discord, 3);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.invalid);
  expect(await runsOf(world.factory)).toStrictEqual([]);
});

it("consent survives turning Chat control Off and On again within its lifetime", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  assert((await world.factory.setChatControlEnabled({ enabled: false })).ok);
  await turnedOn(world.factory, world.discord, 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(await runsOf(world.factory)).toHaveLength(1);
});

it("rotating the same application's bot token while On keeps the waiting review confirmable", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  const rotated = "rotated-bot-token.discord.secret";
  world.discord.addBot({ token: rotated, applicationId: discordBot.applicationId });
  const saved = await world.factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "replace", value: rotated } }),
  );
  assert(saved.ok, JSON.stringify(saved));
  await servingAgain(world.discord, 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(await runsOf(world.factory)).toHaveLength(1);
});

it("a review presented before a backend restart is confirmed once after it", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  await world.factory.close();
  const reopened = await world.open();
  await servingAgain(world.discord, 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(await runsOf(reopened)).toStrictEqual([{ number: 1, title: "Improve search" }]);
});

it("a confirmation works while the language model fails, with no model request", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.model.fail(500, { error: "down" });
  const requests = world.model.requests.length;

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(world.model.requests).toHaveLength(requests);
  await createdBesidesReports(world.discord, 3);
  expect(besidesReports(world.discord)[2]!.content).toContain("✅ **Run #1 started**");
});

it("a definitive Start rejection uses up the consent and posts a not-accepted receipt", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  assert((await world.factory.removeFlow(world.flow.id)).ok);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.rejected);
  await createdBesidesReports(world.discord, 3);
  expect(besidesReports(world.discord)[2]!.content).toMatch(
    /^❌ \*\*Start not accepted\*\* — [^\n]+(?:\n• [^\n]+)*$/,
  );
  expect(await runsOf(world.factory)).toStrictEqual([]);
});

it("a later turn reads the proposal's accepted outcome from Factory's facts instead of proposing again", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  await clicked(world.discord, button, "610000000000000001", 1);
  await createdBesidesReports(world.discord, 3);
  world.model.script({ text: "It started as Run #1." });

  // Act
  world.discord.deliver(invocation("600000000000000002", { content: "did it start?" }));

  // Assert
  await createdBesidesReports(world.discord, 4);
  expect(toolResults(world.model, 1)).toStrictEqual([
    expect.objectContaining({
      operation: "start",
      requester: PARTICIPANT_ID,
      current: {
        state: "accepted",
        outcome: expect.objectContaining({ runNumber: 1, title: "Improve search" }),
      },
    }),
  ]);
});

it("a UI-started Run gets no status card, while a chat-started Run in the same Project gets one in its originating thread", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const uiStarted = await world.factory.startTextRun({
    requestId: "ui-start-1",
    projectId: world.project.id,
    flowId: world.flow.id,
    input: "Started in Factory\nNot through chat.",
  });
  assert(uiStarted.ok, JSON.stringify(uiStarted));
  const button = await proposedStart(world, "600000000000000001", 2);

  // Act
  await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  await world.discord.createdWhere(isStatusCard, 1);
  await createdBesidesReports(world.discord, 3);
  expect(statusCardsIn(world.discord)).toStrictEqual([
    expect.objectContaining({
      channelId: THREAD,
      content: expect.stringMatching(/^\*\*Run #2 · Improve search\*\* · 🟢 Active\n/),
    }),
  ]);
});

const owedReceipt = (world: Awaited<ReturnType<typeof startingWorld>>) =>
  discordSettingsWhen(world.factory, (settings) => settings.delivery.problems.length > 0);

it("a receipt create Discord performed without answering is asked again under its enforced nonce and shows once", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages("lost");

  // Act
  await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  await world.discord.createdWhere(isStatusCard, 1);
  expect(
    besidesReports(world.discord)
      .slice(2)
      .map((message) => message.content),
  ).toStrictEqual([expect.stringMatching(/^✅ \*\*Run #1 started\*\*/)]);
  const creates = world.discord
    .requested("POST", MESSAGE_CREATES)
    .map((request) => request.body as { nonce: string; enforce_nonce: boolean; content: string })
    .filter((create) => create.content.startsWith("✅ **Run #1 started**"));
  expect(creates).toHaveLength(2);
  expect(creates[1]!.nonce).toBe(creates[0]!.nonce);
  expect(creates.map((create) => create.enforce_nonce)).toStrictEqual([true, true]);
  const settings = await world.factory.getDiscordSettings();
  assert(settings.ok);
  expect(settings.value.delivery.problems).toStrictEqual([]);
});

it("a confirmation button whose create failed without proof is asked again under its nonce, shows once and confirms", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  world.discord.faultMessages("delivered", "delivered", "delivered", "failed");
  const button = await proposedStart(world, "600000000000000001", 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ANSWERS.accepted);
  expect(confirmations(world.discord)).toHaveLength(1);
  expect(await runsOf(world.factory)).toHaveLength(1);
});

it("a receipt create still unproven after its re-attempts under the nonce is not repeated and is shown in Settings as unknown", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages(...unproven("lost"));

  // Act
  await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  const settings = await owedReceipt(world);
  expect(settings.delivery.problems).toStrictEqual([
    expect.objectContaining({
      purpose: "receipt",
      state: "unknown",
      threadId: THREAD,
      parentChannelId: ALLOWED_CHANNEL,
      message:
        "Factory cannot tell whether Discord created the message. Retrying may post it twice.",
      nextAttemptAt: null,
    }),
  ]);
  expect(settings.needsAttention).toBe(true);
  expect(besidesReports(world.discord)).toHaveLength(3);
});

it("the warned Retry sends an unknown receipt once more and never starts another Run", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages(...unproven("lost"));
  await clicked(world.discord, button, "610000000000000001", 1);
  const [problem] = (await owedReceipt(world)).delivery.problems;
  world.discord.nonceWindowPassed();

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem!.id,
    duplicateRiskAccepted: true,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  await createdBesidesReports(world.discord, 4);
  expect(besidesReports(world.discord)[3]!.content).toBe(besidesReports(world.discord)[2]!.content);
  const settings = await discordSettingsWhen(
    world.factory,
    (current) => current.delivery.problems.length === 0,
  );
  expect(settings.needsAttention).toBe(false);
  expect(await runsOf(world.factory)).toHaveLength(1);
});

it("Retry of an unknown receipt is refused until the owner accepts a possible duplicate", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages(...unproven("lost"));
  await clicked(world.discord, button, "610000000000000001", 1);
  const [problem] = (await owedReceipt(world)).delivery.problems;

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem!.id,
    duplicateRiskAccepted: false,
  });

  // Assert
  assert(!retried.ok);
  expect(retried.error.issues[0]?.code).toBe("chat_delivery_duplicate_risk");
  expect(besidesReports(world.discord)).toHaveLength(3);
});

it("a receipt Discord refused is shown as failed, and Retry after correction delivers it without a duplicate warning", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages("refused");
  await clicked(world.discord, button, "610000000000000001", 1);
  const [problem] = (await owedReceipt(world)).delivery.problems;

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem!.id,
    duplicateRiskAccepted: false,
  });

  // Assert
  expect(problem!.state).toBe("failed");
  assert(retried.ok, JSON.stringify(retried));
  await createdBesidesReports(world.discord, 3);
  expect(besidesReports(world.discord)[2]!.content).toContain("✅ **Run #1 started**");
});

it("a rate-limited receipt is retried automatically", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages("rate-limited");

  // Act
  await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  await createdBesidesReports(world.discord, 3);
  expect(besidesReports(world.discord)[2]!.content).toContain("✅ **Run #1 started**");
});

it("revoking the receipt's destination cancels the owed receipt and keeps the accepted Run", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages("refused");
  await clicked(world.discord, button, "610000000000000001", 1);
  await owedReceipt(world);

  // Act
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], []);

  // Assert
  const settings = await world.factory.getDiscordSettings();
  assert(settings.ok);
  expect(settings.value.delivery.problems).toStrictEqual([]);
  expect(await runsOf(world.factory)).toHaveLength(1);
});

it("a receipt create interrupted by a backend stop is unknown after restart and not sent again", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 2);
  world.discord.faultMessages("held");
  await clicked(world.discord, button, "610000000000000001", 1);
  await world.discord.request("POST", /^\/api\/v10\/channels\/\d+\/messages$/, 3);
  await world.factory.close();

  // Act
  const reopened = await world.open();

  // Assert
  const settings = await reopened.getDiscordSettings();
  assert(settings.ok);
  expect(settings.value.delivery.problems).toStrictEqual([
    expect.objectContaining({ state: "unknown", purpose: "receipt" }),
  ]);
  await servingAgain(world.discord, 2);
  expect(await runsOf(reopened)).toHaveLength(1);
});

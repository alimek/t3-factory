import { assert, expect, it } from "@effect/vitest";
import {
  clicked,
  isStatusCard,
  proposedStart,
  runsOf,
  startingWorld,
  statusCardsIn,
} from "./support/chat-actions.ts";
import {
  discordBot,
  discordConnectionSave,
  discordSettingsWhen,
  servingAgain,
  turnedOn,
} from "./support/chat-control.ts";
import {
  COLLABORATOR_ID,
  invocation,
  requestMessages,
  savedAccess,
  THREAD,
  toolResults,
  userEnvelopes,
} from "./support/chat-conversation.ts";
import { addedProject, calls, readRun } from "./support/chat-runs.ts";
import { PARTICIPANT_ID } from "./support/controlled-discord.ts";
import { resultReported, settled } from "./support/scenarios.ts";
import { cardProblem, cardShows, chatStartedRun } from "./support/status-cards.ts";

const NOTICE =
  "_Factory's Discord application changed. Messages the previous bot posted in this thread are no longer updated; this card replaces its status card._";
const CORRECTIONS = {
  locked:
    "The thread is locked, and Factory never unlocks threads. Unlock it in Discord, then retry.",
  missingThread:
    "Discord does not show the thread to the bot: it was deleted or the bot lost access. Factory never recreates a thread or posts elsewhere. Restore the bot's access, then retry.",
  replacementLost:
    "Discord deleted this Run's replacement status card too. Factory does not create another on its own; Retry creates a new card.",
  unknown: "Factory cannot tell whether Discord created the message. Retrying may post it twice.",
} as const;

/** The other application a replaced Discord connection names. */
const otherBot = { token: "other-bot-token.discord.secret", applicationId: "123456789012345679" };

type World = Awaited<ReturnType<typeof startingWorld>>;

/** The Run's worker reports its result, its turn ends and Factory settles the Run. */
async function finished(
  world: Pick<World["world"], "t3"> & { factory: World["factory"] },
  worker: Awaited<ReturnType<typeof chatStartedRun>>["worker"],
) {
  await resultReported(world, worker, { message: "Implemented the requested result." });
  await settled(world, worker);
}

it("ordinary Block activity edits the Run's one status card in its originating thread, without new messages or report bodies", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  const messages = world.discord.created.length;

  // Act
  await finished(world.world, worker);

  // Assert
  const shown = await cardShows(world.discord, card, /· Settled\n/);
  expect(shown.channelId).toBe(THREAD);
  expect(shown.content).toMatch(
    /^\*\*Run #1 · Improve search\*\* · Settled\nProject: [^\n]+ · Flow: Single worker\n\*\*Latest results\*\*\n• Entry worker: finished via “Done”, accepted <t:\d+:f> · worker finished\n/,
  );
  expect(shown.content).not.toContain("Implemented the requested result.");
  expect(world.discord.created).toHaveLength(messages);
  expect(statusCardsIn(world.discord)).toHaveLength(1);
});

it("a new card shows the Run's identity, its active Block and that Factory keeps it current", async (c) => {
  // Arrange
  const world = await startingWorld(c);

  // Act
  const { card } = await chatStartedRun(world);

  // Assert
  const shown = await cardShows(world.discord, card, /Entry worker: working/);
  expect(shown.content).toBe(
    `**Run #1 · Improve search** · Active\nProject: ${world.project.title} (\`${world.project.workspaceRoot}\`) · Flow: Single worker\n**Active Blocks**\n• Entry worker: working\nFactory keeps this card current. Ask Factory to read Run #1 for results and details.`,
  );
});

it("Snooze keeps the card reported, and a failing language model does not stop it", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, card } = await chatStartedRun(world);
  world.model.fail(500, { error: "down" });
  const requests = world.model.requests.length;

  // Act
  const snoozed = await world.factory.snoozeRun(runId);

  // Assert
  assert(snoozed.ok, JSON.stringify(snoozed));
  await cardShows(world.discord, card, /^\*\*Run #1 · Improve search\*\* · Snoozed\n/);
  expect(world.model.requests).toHaveLength(requests);
});

it("while Chat control is Off the card is not edited, and turning it On brings the same card to the current state", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  assert((await world.factory.setChatControlEnabled({ enabled: false })).ok);
  await finished(world.world, worker);
  const editsWhileOff = world.discord.edits.length;
  const messages = world.discord.created.length;

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  await cardShows(world.discord, card, /· Settled\n/);
  expect(
    world.discord.edits.slice(0, editsWhileOff).some((edit) => edit.content.includes("Settled")),
  ).toBe(false);
  expect(world.discord.created).toHaveLength(messages);
});

it("a Run that settled while Discord was unreachable gets its card brought current after a restart", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  await world.factory.close();
  world.discord.setGatewayAvailable(false);
  const unreachable = await world.open();
  await finished({ factory: unreachable, t3: world.t3 }, worker);
  await unreachable.close();
  world.discord.setGatewayAvailable(true);

  // Act
  await world.open();

  // Assert
  await cardShows(world.discord, card, /· Settled\n/);
  expect(statusCardsIn(world.discord)).toHaveLength(1);
});

it("revoking the thread's Project stops card edits, and a regrant silently corrects the known card to the current state", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  await finished(world.world, worker);
  const editsWhileRevoked = world.discord.edits.length;
  const messages = world.discord.created.length;

  // Act
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);

  // Assert
  await cardShows(world.discord, card, /· Settled\n/);
  expect(
    world.discord.edits
      .slice(0, editsWhileRevoked)
      .some((edit) => edit.content.includes("Settled")),
  ).toBe(false);
  expect(world.discord.created).toHaveLength(messages);
});

it("removing only the initiating user from Access keeps the Run's card maintained", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);

  // Act
  await finished(world.world, worker);

  // Assert
  await cardShows(world.discord, card, /· Settled\n/);
});

it("a regrant creates the card an Active Run never got because its destination was revoked", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 4);
  world.discord.faultMessages("delivered", "refused");
  await clicked(world.discord, button, "610000000000000001", 1);
  await cardProblem(world.factory, "failed");
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);

  // Act
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);

  // Assert
  await world.discord.createdWhere(isStatusCard, 1);
  expect(statusCardsIn(world.discord)).toStrictEqual([
    expect.objectContaining({
      channelId: THREAD,
      content: expect.stringMatching(/^\*\*Run #1 · Improve search\*\* · Active\n/),
    }),
  ]);
  const settings = await discordSettingsWhen(
    world.factory,
    (current) => current.delivery.problems.length === 0,
  );
  expect(settings.needsAttention).toBe(false);
});

it("after the Discord application is replaced, only the Active Run gets a new card from the new bot, which explains once that the old messages are no longer updated", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const quiet = await chatStartedRun(world, 1, "Settle first\nQuickly.");
  await finished(world.world, quiet.worker);
  await cardShows(world.discord, quiet.card, /· Settled\n/);
  const active = await chatStartedRun(world, 2, "Keep going\nSlowly.");
  world.discord.addBot(otherBot);
  assert((await world.factory.setChatControlEnabled({ enabled: false })).ok);
  const replaced = await world.factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      applicationId: otherBot.applicationId,
      token: { kind: "replace", value: otherBot.token },
      applicationChangeConfirmed: true,
    }),
  );
  assert(replaced.ok, JSON.stringify(replaced));
  const oldCards = statusCardsIn(world.discord).map((card) => card.content);

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  const fromNewBot = (message: { applicationId: string; content: string }) =>
    message.applicationId === otherBot.applicationId && isStatusCard(message);
  await world.discord.createdWhere(fromNewBot, 1);
  const replacement = world.discord.created.filter(fromNewBot);
  expect(replacement).toStrictEqual([
    expect.objectContaining({
      channelId: THREAD,
      content: expect.stringContaining(`${NOTICE}\n\n**Run #2 · Keep going** · Active\n`),
    }),
  ]);
  expect([quiet.card.content, active.card.content]).toStrictEqual(oldCards);
});

it("rotating the same application's token keeps editing the same card", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  world.discord.addBot({ token: "rotated-bot-token", applicationId: discordBot.applicationId });
  const rotated = await world.factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "replace", value: "rotated-bot-token" } }),
  );
  assert(rotated.ok, JSON.stringify(rotated));
  await servingAgain(world.discord, 2);

  // Act
  await finished(world.world, worker);

  // Assert
  await cardShows(world.discord, card, /· Settled\n/);
  expect(statusCardsIn(world.discord)).toHaveLength(1);
});

it("an archived, unlocked thread is reopened to edit the card, without posting a message to wake it", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  world.discord.archiveThread(THREAD);
  const messages = world.discord.created.length;

  // Act
  await finished(world.world, worker);

  // Assert
  await cardShows(world.discord, card, /· Settled\n/);
  expect(world.discord.threadArchived(THREAD)).toBe(false);
  expect(
    world.discord.requested("PATCH", new RegExp(`^/api/v10/channels/${THREAD}$`)),
  ).toStrictEqual([expect.objectContaining({ body: { archived: false } })]);
  expect(world.discord.created).toHaveLength(messages);
});

it("a locked thread is never unlocked: the card edit shows as a failed delivery with its correction", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.archiveThread(THREAD, { locked: true });

  // Act
  await finished(world.world, worker);

  // Assert
  const settings = await cardProblem(world.factory, "failed");
  expect(settings.delivery.problems).toStrictEqual([
    expect.objectContaining({
      purpose: "status-card",
      state: "failed",
      threadId: THREAD,
      message: CORRECTIONS.locked,
    }),
  ]);
  expect(settings.needsAttention).toBe(true);
  expect(world.discord.requested("PATCH", new RegExp(`^/api/v10/channels/${THREAD}$`))).toEqual([]);
});

it("after the host unlocks the thread, Retry edits the card and clears the failure", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  world.discord.archiveThread(THREAD, { locked: true });
  await finished(world.world, worker);
  const [problem] = (await cardProblem(world.factory, "failed")).delivery.problems;
  world.discord.unlockThread(THREAD);

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem!.id,
    duplicateRiskAccepted: false,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  await cardShows(world.discord, card, /· Settled\n/);
  const settings = await discordSettingsWhen(
    world.factory,
    (current) => current.delivery.problems.length === 0,
  );
  expect(settings.needsAttention).toBe(false);
});

it("a card Discord proved deleted is replaced once automatically with the current state", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  world.discord.deleteMessage(card.id);

  // Act
  await finished(world.world, worker);

  // Assert
  await world.discord.createdWhere(isStatusCard, 2);
  const replacement = statusCardsIn(world.discord)[1]!;
  await cardShows(world.discord, replacement, /· Settled\n/);
  expect(replacement.channelId).toBe(THREAD);
});

it("when the replacement card is deleted too, a restart does not renew the allowance: no third card until the host's Retry", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker, card } = await chatStartedRun(world);
  world.discord.deleteMessage(card.id);
  assert((await world.factory.snoozeRun(runId)).ok);
  await world.discord.createdWhere(isStatusCard, 2);
  await world.factory.close();
  const reopened = await world.open();
  await servingAgain(world.discord, 2);
  world.discord.deleteMessage(statusCardsIn(world.discord)[1]!.id);

  // Act
  await finished({ factory: reopened, t3: world.t3 }, worker);

  // Assert
  const settings = await cardProblem(reopened, "failed");
  expect(settings.delivery.problems).toStrictEqual([
    expect.objectContaining({ purpose: "status-card", message: CORRECTIONS.replacementLost }),
  ]);
  expect(statusCardsIn(world.discord)).toHaveLength(2);
});

it("the host's Retry after a lost replacement creates one new card with the current state", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker, card } = await chatStartedRun(world);
  world.discord.deleteMessage(card.id);
  assert((await world.factory.snoozeRun(runId)).ok);
  await world.discord.createdWhere(isStatusCard, 2);
  world.discord.deleteMessage(statusCardsIn(world.discord)[1]!.id);
  await finished(world.world, worker);
  const [problem] = (await cardProblem(world.factory, "failed")).delivery.problems;

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem!.id,
    duplicateRiskAccepted: false,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  await world.discord.createdWhere(isStatusCard, 3);
  expect(statusCardsIn(world.discord)[2]!.content).toMatch(/· Settled\n/);
  await discordSettingsWhen(world.factory, (current) => current.delivery.problems.length === 0);
});

it("a card create Discord may already have performed is not repeated and is shown as unknown", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 4);
  world.discord.faultMessages("delivered", "lost");

  // Act
  await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  const settings = await cardProblem(world.factory, "unknown");
  expect(settings.delivery.problems).toStrictEqual([
    expect.objectContaining({
      purpose: "status-card",
      state: "unknown",
      threadId: THREAD,
      message: CORRECTIONS.unknown,
    }),
  ]);
  expect(statusCardsIn(world.discord)).toHaveLength(1);
});

it("the warned Retry of an unknown card create posts it once more with the current state and never starts another Run", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const button = await proposedStart(world, "600000000000000001", 4);
  world.discord.faultMessages("delivered", "lost");
  await clicked(world.discord, button, "610000000000000001", 1);
  const [problem] = (await cardProblem(world.factory, "unknown")).delivery.problems;
  const navigation = await world.factory.listRunNavigation();
  assert(navigation.ok);
  assert((await world.factory.snoozeRun(navigation.value[0]!.id)).ok);

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem!.id,
    duplicateRiskAccepted: true,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  await world.discord.createdWhere(isStatusCard, 2);
  expect(statusCardsIn(world.discord)[1]!.content).toMatch(/· Snoozed\n/);
  expect(await runsOf(world.factory)).toHaveLength(1);
  await discordSettingsWhen(world.factory, (current) => current.delivery.problems.length === 0);
});

it("a deleted thread is not taken as a deleted card: no replacement or other destination, and the failure stays listed after Archive", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId } = await chatStartedRun(world);
  world.discord.deleteThread(THREAD);

  // Act
  const archived = await world.factory.archiveRun(runId);

  // Assert
  assert(archived.ok, JSON.stringify(archived));
  const settings = await cardProblem(world.factory, "failed");
  expect(settings.delivery.problems).toStrictEqual([
    expect.objectContaining({
      purpose: "status-card",
      threadId: THREAD,
      message: CORRECTIONS.missingThread,
    }),
  ]);
  expect(statusCardsIn(world.discord)).toHaveLength(1);
});

it("a reply to the Run's status card gives the model only the Run's ID to read afresh, never the card's text", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, card } = await chatStartedRun(world);
  world.model.script({ text: "Reading it." });
  const requests = world.model.requests.length;

  // Act
  world.discord.deliver(
    invocation("620000000000000001", {
      content: "how is this going?",
      replyTo: {
        id: card.id,
        channelId: THREAD,
        authorId: discordBot.applicationId,
        content: card.content,
        authorIsBot: true,
      },
    }),
  );

  // Assert
  await world.model.requested(requests + 1);
  expect(userEnvelopes(world.model, requests).at(-1)).toStrictEqual(
    expect.objectContaining({
      message: expect.stringContaining("how is this going?"),
      referencedRun: runId,
    }),
  );
  expect(JSON.stringify(requestMessages(world.model, requests))).not.toContain(
    "Factory keeps this card current",
  );
});

it("a card's Run in a Project the thread no longer permits reads as not found", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, card } = await chatStartedRun(world);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  world.model.script(calls(readRun({ run: runId })), { text: "Not visible here." });
  const requests = world.model.requests.length;

  // Act
  world.discord.deliver(
    invocation("620000000000000001", {
      content: "what about this one?",
      replyTo: {
        id: card.id,
        channelId: THREAD,
        authorId: discordBot.applicationId,
        content: card.content,
        authorIsBot: true,
      },
    }),
  );

  // Assert
  await world.model.requested(requests + 2);
  expect(userEnvelopes(world.model, requests).at(-1)).toStrictEqual(
    expect.objectContaining({ referencedRun: runId }),
  );
  expect(toolResults(world.model, requests + 1)).toStrictEqual([
    expect.objectContaining({ error: "not_found" }),
  ]);
});

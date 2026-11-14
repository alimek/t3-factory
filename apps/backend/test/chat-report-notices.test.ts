import { assert, expect, it } from "@effect/vitest";
import { isStatusCard, noticesIn, runsOf, startingWorld } from "./support/chat-actions.ts";
import { discordConnectionSave, discordSettingsWhen, turnedOn } from "./support/chat-control.ts";
import { COLLABORATOR_ID, savedAccess, THREAD } from "./support/chat-conversation.ts";
import { addedProject } from "./support/chat-runs.ts";
import { PARTICIPANT_ID } from "./support/controlled-discord.ts";
import {
  nativeRequestAnswered,
  nativeRequestShown,
  noticeCreated,
} from "./support/report-notices.ts";
import {
  fanOutFlow,
  humanReviewFlow,
  launchedWorkers,
  missingReport,
  resultReleasedToHumanReview,
  resultReported,
  settled,
  woke,
  workingReported,
} from "./support/scenarios.ts";
import { chatStartedRun, messageShows } from "./support/status-cards.ts";

type World = Awaited<ReturnType<typeof startingWorld>>;
type Worker = Awaited<ReturnType<typeof chatStartedRun>>["worker"];

/** A Discord timestamp in a notice. */
const AT = "<t:\\d+:f>";
const MESSAGES = new RegExp(`^/api/v10/channels/${THREAD}/messages$`);
/** The other application a replaced Discord connection names. */
const otherBot = { token: "other-bot-token.discord.secret", applicationId: "123456789012345679" };

/** The Run's worker reports its result, its turn ends and Factory settles the Run. */
async function finished(world: Pick<World, "world">, worker: Worker) {
  await resultReported(world.world, worker, { message: "Implemented the requested result." });
  await settled(world.world, worker);
}

/** A chat-started Run of the Human review Flow whose Review waits on its pending occurrence. */
async function reviewPending(world: World) {
  const started = await chatStartedRun(world);
  await resultReported(world.world, started.worker);
  const review = await resultReleasedToHumanReview(world.world, started.worker);
  return { ...started, occurrence: review.occurrence };
}

const turnedOff = async (world: Pick<World, "factory">) =>
  assert((await world.factory.setChatControlEnabled({ enabled: false })).ok);

/**
 * A chat-started Run of the Fan-out Flow that, while Chat control was Off, got a native request on
 * Second entry that was answered again, a native request on Entry worker and a missing report on
 * Second entry still pending.
 */
async function mattersWhileOff(world: World) {
  const { runId } = await chatStartedRun(world);
  const { workers } = await launchedWorkers(world.world, runId);
  const entry = workers.find((worker) => worker.flowBlockId === "worker")!;
  const second = workers.find((worker) => worker.flowBlockId === "second")!;
  await turnedOff(world);
  await nativeRequestShown(world.world, second);
  await nativeRequestAnswered(world.world, second);
  await nativeRequestShown(world.world, entry);
  await missingReport(world.world, second);
  return { runId, entry, second };
}

/** Saves `otherBot`'s token while Chat control is Off, so the next session replaces the application. */
async function applicationReplaced(world: World) {
  world.discord.addBot(otherBot);
  await turnedOff(world);
  const replaced = await world.factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "replace", value: otherBot.token } }),
  );
  assert(replaced.ok, JSON.stringify(replaced));
}

it("a Run becoming Settled posts one lifecycle notice in its originating thread, while its Block activity only edits the card", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  const messages = world.discord.created.length;

  // Act
  await finished(world, worker);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.channelId).toBe(THREAD);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* is Settled since ${AT}\\.\\nAsk Factory to read Run #1 for details\\.$`,
    ),
  );
  expect(world.discord.created.slice(messages)).toStrictEqual([notice]);
});

it("a new Human step posts one Needs input notice that leads to a review in the thread, without answer buttons", async (c) => {
  // Arrange
  const world = await startingWorld(c, humanReviewFlow);
  const { worker } = await chatStartedRun(world);
  await resultReported(world.world, worker);

  // Act
  await resultReleasedToHumanReview(world.world, worker);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* needs input\\n• Human step Review waits for an answer, since ${AT}\\. Ask Factory in this thread to review it; answering takes your confirmation\\.$`,
    ),
  );
  expect(notice.components).toEqual([]);
});

it("answering the Human step edits its notice in place to resolved, without a new message", async (c) => {
  // Arrange
  const world = await startingWorld(c, humanReviewFlow);
  const { occurrence } = await reviewPending(world);
  const notice = await noticeCreated(world.discord);
  const messages = world.discord.created.length;

  // Act
  const answered = await world.factory.answerHumanOccurrence(occurrence.id, { exitId: "approve" });

  // Assert
  assert(answered.ok, JSON.stringify(answered));
  const shown = await messageShows(world.discord, notice, /· resolved\n/);
  expect(shown.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* needs input · resolved\\n• ~~Human step Review waits for an answer, since ${AT}~~ · resolved$`,
    ),
  );
  expect(world.discord.created).toHaveLength(messages);
});

it("a native T3 request of a Snoozed Run posts a Needs input notice to answer it in T3", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);

  // Act
  await woke(world.world, worker);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* needs input\\n• Entry worker has a T3 request, since ${AT}\\. Answer it in T3\\.$`,
    ),
  );
});

it("notices mention nobody: mention syntax in a Run's title stays inert and every notice allows no mentions", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world, 1, "@everyone fix <@&123456789012345678>\nNow.");

  // Act
  await finished(world, worker);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toContain("**Run #1 · @\u200beveryone fix <@\u200b&123456789012345678>**");
  expect(
    world.discord
      .requested("POST", MESSAGES)
      .filter((request) => (request.body as { content: string }).content === notice.content),
  ).toStrictEqual([
    expect.objectContaining({
      body: expect.objectContaining({ allowed_mentions: { parse: [] } }),
    }),
  ]);
});

it("after Chat control was Off, one catch-up lists each matter still pending on its own line, and nothing for a matter that opened and resolved meanwhile", async (c) => {
  // Arrange
  const world = await startingWorld(c, fanOutFlow);
  await mattersWhileOff(world);
  const messages = world.discord.created.length;

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* · while Factory could not post in this thread:\\n• Entry worker has a T3 request, since ${AT}\\. Answer it in T3\\.\\n• Second entry: report missing, since ${AT}\\.$`,
    ),
  );
  expect(world.discord.created.slice(messages)).toStrictEqual([notice]);
});

it("resolving one matter of a catch-up edits only its own line in place", async (c) => {
  // Arrange
  const world = await startingWorld(c, fanOutFlow);
  const { entry } = await mattersWhileOff(world);
  await turnedOn(world.factory, world.discord, 2);
  const notice = await noticeCreated(world.discord);

  // Act
  await nativeRequestAnswered(world.world, entry);

  // Assert
  const shown = await messageShows(world.discord, notice, /~~/);
  expect(shown.content).toMatch(
    new RegExp(
      `\\n• ~~Entry worker has a T3 request, since ${AT}~~ · resolved\\n• Second entry: report missing, since ${AT}\\.$`,
    ),
  );
  expect(noticesIn(world.discord)).toHaveLength(1);
});

it("a Run that settled while Chat control was Off gets one catch-up after a restart, labelled delivered late", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await turnedOff(world);
  await finished(world, worker);
  await world.factory.close();
  const reopened = await world.open();

  // Act
  await turnedOn(reopened, world.discord, 2);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* · while Factory could not post in this thread:\\n• Settled ${AT}, delivered late$`,
    ),
  );
  expect(noticesIn(world.discord)).toHaveLength(1);
});

it("a Settled outcome already posted gets nothing more when Chat control is turned Off and On again", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker, card } = await chatStartedRun(world);
  await finished(world, worker);
  const settledNotice = await noticeCreated(world.discord);
  await turnedOff(world);
  assert((await world.factory.renameRun(runId, { title: "Renamed while Off" })).ok);

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  // Once the renamed card shows, the session serves; a later Archive's notice comes after
  // anything turning On would have posted.
  await messageShows(world.discord, card, /Renamed while Off/);
  assert((await world.factory.archiveRun(runId)).ok);
  const archivedNotice = await noticeCreated(world.discord, 2);
  expect(archivedNotice.content).toMatch(/^\*\*Run #1 · Renamed while Off\*\* was Archived at /);
  expect(noticesIn(world.discord)).toStrictEqual([settledNotice, archivedNotice]);
});

it("a catch-up Discord rate-limited before an Off and On flap is posted once", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await turnedOff(world);
  await finished(world, worker);
  const posts = world.discord.requested("POST", MESSAGES).length;
  world.discord.faultMessages("rate-limited");
  await turnedOn(world.factory, world.discord, 2);
  await world.discord.request("POST", MESSAGES, posts + 1);
  await turnedOff(world);

  // Act
  await turnedOn(world.factory, world.discord, 3);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(/\n• Settled <t:\d+:f>, delivered late$/);
  expect(noticesIn(world.discord)).toHaveLength(1);
});

it("a Settled Run whose Agent reports again posts a notice that it returned to Active", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await finished(world, worker);
  await noticeCreated(world.discord);

  // Act
  await workingReported(world.world, worker);

  // Assert
  const notice = await noticeCreated(world.discord, 2);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* returned to Active at ${AT}\\.\\nAsk Factory to read Run #1 for details\\.$`,
    ),
  );
});

it("Archive edits the pending matter's notice to resolved and posts one notice that the Run was Archived", async (c) => {
  // Arrange
  const world = await startingWorld(c, humanReviewFlow);
  const { runId } = await reviewPending(world);
  const pending = await noticeCreated(world.discord);

  // Act
  const archived = await world.factory.archiveRun(runId);

  // Assert
  assert(archived.ok, JSON.stringify(archived));
  await messageShows(
    world.discord,
    pending,
    /^\*\*Run #1 · Improve search\*\* needs input · resolved\n/,
  );
  const notice = await noticeCreated(world.discord, 2);
  expect(notice.content).toMatch(
    new RegExp(
      `^\\*\\*Run #1 · Improve search\\*\\* was Archived at ${AT}\\.\\nAsk Factory to read Run #1 for details\\.$`,
    ),
  );
  expect(noticesIn(world.discord)).toHaveLength(2);
});

it("while the thread's Project is revoked nothing accrues, and a regrant posts no notice for what happened meanwhile", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker, card } = await chatStartedRun(world);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  await nativeRequestShown(world.world, worker);

  // Act
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);

  // Assert
  // Once the card shows the request, the regrant was captured; a later Archive's notice comes
  // after anything the regrant would have posted.
  await messageShows(world.discord, card, /\*\*Needs input\*\*/);
  assert((await world.factory.archiveRun(runId)).ok);
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(/^\*\*Run #1 · Improve search\*\* was Archived at /);
  expect(noticesIn(world.discord)).toStrictEqual([notice]);
});

it("after the Discord application is replaced, the old bot's notice is not edited when its matter resolves and nothing is posted again", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await nativeRequestShown(world.world, worker);
  const notice = await noticeCreated(world.discord);
  const shownBefore = notice.content;
  await applicationReplaced(world);
  await nativeRequestAnswered(world.world, worker);

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  const fromNewBot = (message: { applicationId: string; content: string }) =>
    message.applicationId === otherBot.applicationId && isStatusCard(message);
  await world.discord.createdWhere(fromNewBot, 1);
  expect(noticesIn(world.discord)).toStrictEqual([
    expect.objectContaining({ id: notice.id, content: shownBefore }),
  ]);
  expect(world.discord.requested("PATCH", new RegExp(`/messages/${notice.id}$`))).toEqual([]);
});

it("a quiet Run that settled while the application was replaced gets its outcome once from the new bot, which says the old bot's messages are no longer updated", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await applicationReplaced(world);
  await finished(world, worker);

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.applicationId).toBe(otherBot.applicationId);
  expect(notice.content).toMatch(
    new RegExp(
      `^_Factory's Discord application changed\\. Messages the previous bot posted in this thread are no longer updated\\._\\n\\n\\*\\*Run #1 · Improve search\\*\\* · while Factory could not post in this thread:\\n• Settled ${AT}, delivered late$`,
    ),
  );
  expect(noticesIn(world.discord)).toHaveLength(1);
});

it("a notice Discord proved deleted is not recreated when its matter resolves", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker } = await chatStartedRun(world);
  await nativeRequestShown(world.world, worker);
  const notice = await noticeCreated(world.discord);
  world.discord.deleteMessage(notice.id);

  // Act
  await nativeRequestAnswered(world.world, worker);

  // Assert
  await world.discord.request("PATCH", new RegExp(`/messages/${notice.id}$`));
  // Archiving afterwards orders a later notice after anything the lost notice would have posted.
  assert((await world.factory.archiveRun(runId)).ok);
  const archived = await noticeCreated(world.discord, 2);
  expect(noticesIn(world.discord)).toStrictEqual([
    expect.objectContaining({ id: notice.id, deleted: true }),
    archived,
  ]);
});

it("a notice whose create Discord may have performed leaves Settings without a Retry once its matter resolved", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.faultMessages("lost");
  await nativeRequestShown(world.world, worker);
  await discordSettingsWhen(world.factory, (settings) =>
    settings.delivery.problems.some(
      (problem) => problem.purpose === "attention" && problem.state === "unknown",
    ),
  );

  // Act
  await nativeRequestAnswered(world.world, worker);

  // Assert
  const settings = await discordSettingsWhen(
    world.factory,
    (current) => current.delivery.problems.length === 0,
  );
  expect(settings.needsAttention).toBe(false);
  expect(noticesIn(world.discord)).toHaveLength(1);
});

it("the warned Retry of a Settled notice Discord may not have created posts it once and starts nothing", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.faultMessages("failed");
  await finished(world, worker);
  const settings = await discordSettingsWhen(world.factory, (current) =>
    current.delivery.problems.some(
      (problem) => problem.purpose === "lifecycle" && problem.state === "unknown",
    ),
  );

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: settings.delivery.problems[0]!.id,
    duplicateRiskAccepted: true,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(/^\*\*Run #1 · Improve search\*\* is Settled since /);
  expect(await runsOf(world.factory)).toHaveLength(1);
  await discordSettingsWhen(world.factory, (current) => current.delivery.problems.length === 0);
});

import { assert, expect, it } from "@effect/vitest";
import { isStatusCard, noticesIn, runsOf, startingWorld } from "./support/chat-actions.ts";
import {
  discordBot,
  discordConnectionSave,
  discordSettingsWhen,
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
import { type CreatedMessage, PARTICIPANT_ID, unproven } from "./support/controlled-discord.ts";
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
  optionalEndingFlow,
  resultHeld,
  resultReleasedToHumanReview,
  resultReported,
  settled,
  settleUnresolved,
  singleWorkerFlow,
  type ReadyFlowShape,
  woke,
  workingReportedIdle,
  workerWorking,
} from "./support/scenarios.ts";
import { chatStartedRun, messageShows } from "./support/status-cards.ts";

type World = Awaited<ReturnType<typeof startingWorld>>;
type Worker = Awaited<ReturnType<typeof chatStartedRun>>["worker"];

const MESSAGES = new RegExp(`^/api/v10/channels/${THREAD}/messages$`);
const REQUESTER_MENTION = `<@${PARTICIPANT_ID}>`;
/** The other application a replaced Discord connection names. */
const otherBot = { token: "other-bot-token.discord.secret", applicationId: "123456789012345679" };

const mentionNamedFlow: ReadyFlowShape = async (world) => {
  const { agent, flow } = await singleWorkerFlow(world);
  const saved = await world.factory.updateFlow(flow.id, {
    name: "@everyone Flow",
    expectedRevision: flow.revision,
    expectedProjectId: flow.projectId,
    graph: {
      ...flow.graph,
      blocks: flow.graph.blocks.map((block) => ({
        ...block,
        name: `@here ${REQUESTER_MENTION}`,
      })),
    },
  });
  assert(saved.ok, JSON.stringify(saved));
  return { agent, flow: saved.value };
};

function expectNoticePing(discord: World["discord"], notice: CreatedMessage) {
  expect(notice.content).toContain(REQUESTER_MENTION);
  expect(discord.requested("POST", MESSAGES)).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({
        content: notice.content,
        allowed_mentions: { parse: [], users: [PARTICIPANT_ID] },
      }),
    }),
  );
}

const isCompletion = (message: CreatedMessage) => /^✅ .+ finished\.\n/.test(message.content);
const completions = (discord: World["discord"]) => discord.created.filter(isCompletion);

async function completionCreated(discord: World["discord"], ordinal = 1) {
  await discord.createdWhere(isCompletion, ordinal);
  return completions(discord)[ordinal - 1]!;
}

async function completionProblem(
  factory: Pick<World["factory"], "getDiscordSettings">,
  state: "failed" | "unknown" | "retrying",
) {
  const matches = (problem: { purpose: string; state: string }) =>
    problem.purpose === "completion" && problem.state === state;
  const settings = await discordSettingsWhen(factory, (current) =>
    current.delivery.problems.some(matches),
  );
  return settings.delivery.problems.find(matches)!;
}

function expectSilentEdit(discord: World["discord"], notice: CreatedMessage) {
  expect(notice.content).not.toContain(REQUESTER_MENTION);
  expect(discord.requested("PATCH", new RegExp(`/messages/${notice.id}$`))).toContainEqual(
    expect.objectContaining({ body: { content: notice.content, allowed_mentions: { parse: [] } } }),
  );
}

const noticeReply = (notice: CreatedMessage) =>
  invocation("620000000000000001", {
    authorId: COLLABORATOR_ID,
    content: "what about this one?",
    replyTo: {
      id: notice.id,
      channelId: THREAD,
      authorId: discordBot.applicationId,
      content: notice.content,
      authorIsBot: true,
    },
  });

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

it("automatic settlement posts one plain completion notice to the requester in the originating thread", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);

  // Act
  await finished(world, worker);

  // Assert
  const notice = await completionCreated(world.discord);
  expect(notice.channelId).toBe(THREAD);
  expect(notice.content).toBe(
    `✅ ${REQUESTER_MENTION} **Run #1 · Improve search** finished.\nReply here to inspect the result or choose what to do next.`,
  );
  expectNoticePing(world.discord, notice);
  expect(noticesIn(world.discord)).toStrictEqual([notice]);
});

it("reaching Finish posts a completion notice without disclosing the chosen ending or its output", async (c) => {
  // Arrange
  const world = await startingWorld(c, optionalEndingFlow);
  const { worker } = await chatStartedRun(world);

  // Act
  await finished(world, worker);

  // Assert
  const notice = await completionCreated(world.discord);
  expect(notice.content).toBe(
    `✅ ${REQUESTER_MENTION} **Run #1 · Improve search** finished.\nReply here to inspect the result or choose what to do next.`,
  );
  expectNoticePing(world.discord, notice);
});

it("a Run posts a new completion when it settles again, even after its first notice was deleted", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await finished(world, worker);
  const first = await completionCreated(world.discord);
  world.discord.deleteMessage(first.id);
  expect((await world.factory.runtime.submit(workerWorking(worker.blockId))).code).toBe("ACCEPTED");

  // Act
  await finished(world, worker);

  // Assert
  const second = await completionCreated(world.discord, 2);
  expect(completions(world.discord)).toStrictEqual([
    expect.objectContaining({ id: first.id, deleted: true }),
    second,
  ]);
  expect(second.id).not.toBe(first.id);
  expectNoticePing(world.discord, second);
});

it("reactivating a Run retires its completion waiting for a rate-limit retry", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  world.discord.faultMessages("rate-limited");
  await finished(world, worker);
  const problem = await completionProblem(world.factory, "retrying");

  // Act
  const accepted = await world.factory.runtime.submit(workerWorking(worker.blockId));

  // Assert
  expect(accepted.code).toBe("ACCEPTED");
  await messageShows(world.discord, card, /· 🟢 Active · /);
  await discordSettingsWhen(world.factory, (current) =>
    current.delivery.problems.every(({ id }) => id !== problem.id),
  );
  expect(completions(world.discord)).toEqual([]);
});

it("archiving a Settled Run removes an unproven completion from diagnostics and retires its Retry", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, runId } = await chatStartedRun(world);
  world.discord.faultMessages(...unproven("failed"));
  await finished(world, worker);
  const problem = await completionProblem(world.factory, "unknown");

  // Act
  const archived = await world.factory.archiveRun(runId);

  // Assert
  assert(archived.ok, JSON.stringify(archived));
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem.id,
    duplicateRiskAccepted: true,
  });
  expect(retried).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(completions(world.discord)).toEqual([]);
});

it("reconnecting Discord delivers the completion owed during the Gateway outage", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.holdResume();
  world.discord.interruptSessions();
  await world.discord.resumeAttempted();
  await finished(world, worker);
  expect(completions(world.discord)).toEqual([]);

  // Act
  world.discord.releaseResume();

  // Assert
  expectNoticePing(world.discord, await completionCreated(world.discord));
});

it("reopening Factory discovers a completion whose worker finished while the backend was stopped", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await resultHeld(world.world, worker);
  await world.factory.close();
  world.t3.threads.endThreadRun(worker.threadId, worker.executionId, "completed");

  // Act
  await world.open();

  // Assert
  expectNoticePing(world.discord, await completionCreated(world.discord));
});

it("regrant reports a later settlement without replaying a Run that settled during revocation", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const revoked = await chatStartedRun(world);
  const later = await chatStartedRun(world, 2, "Later authorized work");
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  await finished(world, revoked.worker);
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);
  await messageShows(world.discord, revoked.card, /· ✅ Settled · /);

  // Act
  await finished(world, later.worker);

  // Assert
  const notice = await completionCreated(world.discord);
  expect(notice.content).toContain("**Run #2 · Later authorized work** finished.");
  expectNoticePing(world.discord, notice);
  expect(completions(world.discord)).toHaveLength(1);
});

it("revoking the Project grant cancels a locked-thread completion through regrant", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  world.discord.archiveThread(THREAD, { locked: true });
  await finished(world, worker);
  const problem = await completionProblem(world.factory, "failed");
  expect(problem.message).toContain("Unlock it in Discord, then retry.");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  world.discord.unlockThread(THREAD);

  // Act
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);

  // Assert
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem.id,
    duplicateRiskAccepted: false,
  });
  expect(retried).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(completions(world.discord)).toEqual([]);
});

it("application replacement delivers the completion owed while Off and leaves the first Run's delivered notice alone", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const first = await chatStartedRun(world);
  await finished(world, first.worker);
  const original = await completionCreated(world.discord);
  const second = await chatStartedRun(world, 2, "Follow-up work");
  await applicationReplaced(world);
  await finished(world, second.worker);

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  const recovered = await completionCreated(world.discord, 2);
  expect(recovered.applicationId).toBe(otherBot.applicationId);
  expect(recovered.content).toContain("**Run #2 · Follow-up work** finished.");
  expect(completions(world.discord)).toStrictEqual([original, recovered]);
});

it("an unproven completion requires warned Retry and delivers without a ping after requester removal", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.faultMessages(...unproven("failed"));
  await finished(world, worker);
  const problem = await completionProblem(world.factory, "unknown");
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);
  const unwarned = await world.factory.retryChatDelivery({
    deliveryId: problem.id,
    duplicateRiskAccepted: false,
  });
  expect(unwarned).toMatchObject({
    ok: false,
    error: {
      code: "validation",
      issues: [expect.objectContaining({ code: "chat_delivery_duplicate_risk" })],
    },
  });

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: problem.id,
    duplicateRiskAccepted: true,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  const notice = await completionCreated(world.discord);
  expect(notice.content).not.toContain(REQUESTER_MENTION);
  expect(world.discord.requested("POST", MESSAGES).at(-1)?.body).toEqual(
    expect.objectContaining({ content: notice.content, allowed_mentions: { parse: [] } }),
  );
});

it("a reply to a completion gives the model the Run ID while a revoked Project blocks the read", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker } = await chatStartedRun(world);
  await finished(world, worker);
  const notice = await completionCreated(world.discord);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  world.model.script(calls(readRun({ run: runId })), { text: "Not visible here." });
  const requests = world.model.requests.length;

  // Act
  world.discord.deliver(noticeReply(notice));

  // Assert
  await world.model.requested(requests + 2);
  expect(userEnvelopes(world.model, requests).at(-1)).toEqual(
    expect.objectContaining({ referencedRun: runId }),
  );
  expect(JSON.stringify(requestMessages(world.model, requests))).not.toContain(
    "Reply here to inspect the result or choose what to do next.",
  );
  expect(toolResults(world.model, requests + 1)).toEqual([
    expect.objectContaining({ error: "not_found" }),
  ]);
});

it("a Needs input matter in a locked thread posts no notice there, even though the bot may post in locked threads, and Settings asks to unlock it", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.archiveThread(THREAD, { locked: true });
  const messages = world.discord.created.length;

  // Act
  await nativeRequestShown(world.world, worker);

  // Assert
  const settings = await discordSettingsWhen(world.factory, (current) =>
    current.delivery.problems.some((problem) => problem.purpose === "attention"),
  );
  expect(settings.delivery.problems).toContainEqual(
    expect.objectContaining({
      purpose: "attention",
      state: "failed",
      threadId: THREAD,
      message:
        "The thread is locked, and Factory never unlocks threads. Unlock it in Discord, then retry.",
    }),
  );
  expect(world.discord.created.slice(messages)).toStrictEqual([]);
});

it("a new Human step pings the requester once and points to a review in the thread", async (c) => {
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
      `^🙋 <@${PARTICIPANT_ID}> \\*\\*Run #1 · Improve search\\*\\* needs input\\n• Human step Review waits for an answer — ask here to answer it$`,
    ),
  );
  expect(notice.components).toEqual([]);
  expectNoticePing(world.discord, notice);
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
  const shown = await messageShows(world.discord, notice, /· ✅ resolved\n/);
  expect(shown.content).toMatch(
    new RegExp(
      "^🙋 \\*\\*Run #1 · Improve search\\*\\* needs input · ✅ resolved\\n• ~~Human step Review waits for an answer~~ ✅$",
    ),
  );
  expect(world.discord.created).toHaveLength(messages);
  expectSilentEdit(world.discord, shown);
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
      `^🙋 ${REQUESTER_MENTION} \\*\\*Run #1 · Improve search\\*\\* needs input\\n• Entry worker has a T3 request — answer it in T3$`,
    ),
  );
  expectNoticePing(world.discord, notice);
});

it("catch-up reports a recorded request without adding an idle worker's T3 review state", async (c) => {
  // Arrange
  const world = await startingWorld(c, fanOutFlow);
  const { runId, worker } = await chatStartedRun(world);
  const { workers } = await launchedWorkers(world.world, runId);
  const second = workers.find((item) => item.flowBlockId === "second")!;
  await turnedOff(world);
  await workingReportedIdle(world.world, second);
  await nativeRequestShown(world.world, worker);

  // Act
  await turnedOn(world.factory, world.discord, 2);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content.split("\n").slice(1)).toStrictEqual([
    "• Entry worker has a T3 request — answer it in T3",
  ]);
  expect(noticesIn(world.discord)).toStrictEqual([notice]);
});

it("a confirmed Settle that could not stop workers posts a Problem notice in the originating thread", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);

  // Act
  await settleUnresolved(world.world, worker);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.channelId).toBe(THREAD);
  expect(notice.content).toMatch(
    new RegExp(
      `^⚠️ ${REQUESTER_MENTION} \\*\\*Run #1 · Improve search\\*\\* has a Problem\\n• Settle could not stop workers$`,
    ),
  );
  expectNoticePing(world.discord, notice);
});

it("manual settlement after a failed Stop resolves the Problem notice and posts a completion", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { runId, worker } = await chatStartedRun(world);
  await settleUnresolved(world.world, worker);
  const notice = await noticeCreated(world.discord);
  world.world.t3.contract.support.stop = true;
  world.world.t3.threads.stopsEndThreads();

  // Act
  const settledRun = await world.factory.settleRun(runId, { stopWorkers: true });

  // Assert
  assert(settledRun.ok, JSON.stringify(settledRun));
  const shown = await messageShows(world.discord, notice, /· ✅ resolved\n/);
  expect(shown.content).toMatch(
    new RegExp(
      "^⚠️ \\*\\*Run #1 · Improve search\\*\\* has a Problem · ✅ resolved\\n• ~~Settle could not stop workers~~ ✅$",
    ),
  );
  expectNoticePing(world.discord, await completionCreated(world.discord));
});

it("a notice pings only the requester and leaves mention syntax in Run, Flow, and Block names inert", async (c) => {
  // Arrange
  const world = await startingWorld(c, mentionNamedFlow);
  const { worker, card } = await chatStartedRun(
    world,
    1,
    `@everyone @here <@&123456789012345678> ${REQUESTER_MENTION}\nNow.`,
  );

  // Act
  await nativeRequestShown(world.world, worker);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toContain(
    `**Run #1 · @\u200beveryone @\u200bhere <@\u200b&123456789012345678> <@\u200b${PARTICIPANT_ID}>**`,
  );
  expect(notice.content.split(REQUESTER_MENTION)).toHaveLength(2);
  expect(notice.content).toContain(`• @\u200bhere <@\u200b${PARTICIPANT_ID}> has a T3 request`);
  expect(card.content).toContain("🔀 @\u200beveryone Flow");
  expectNoticePing(world.discord, notice);
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
      `^📬 ${REQUESTER_MENTION} \\*\\*Run #1 · Improve search\\*\\* · while Factory could not post in this thread:\\n• Entry worker has a T3 request — answer it in T3\\n• Second entry: report missing$`,
    ),
  );
  expect(world.discord.created.slice(messages)).toStrictEqual([notice]);
  expectNoticePing(world.discord, notice);
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
    new RegExp("\\n• ~~Entry worker has a T3 request~~ ✅\\n• Second entry: report missing$"),
  );
  expect(noticesIn(world.discord)).toHaveLength(1);
  expectSilentEdit(world.discord, shown);
});

it("a rate-limited catch-up survives a restart and pings the requester once when turned back on", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await turnedOff(world);
  await nativeRequestShown(world.world, worker);
  const posts = world.discord.requested("POST", MESSAGES).length;
  world.discord.faultMessages("rate-limited");
  await turnedOn(world.factory, world.discord, 2);
  await world.discord.request("POST", MESSAGES, posts + 1);
  await turnedOff(world);
  await world.factory.close();
  const reopened = await world.open();

  // Act
  await turnedOn(reopened, world.discord, 3);

  // Assert
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(/\n• Entry worker has a T3 request — answer it in T3$/);
  expect(noticesIn(world.discord)).toHaveLength(1);
  expectNoticePing(world.discord, notice);
});

it("Archive edits the pending matter's notice to resolved and the card to Archived, without a new message", async (c) => {
  // Arrange
  const world = await startingWorld(c, humanReviewFlow);
  const { runId, card } = await reviewPending(world);
  const pending = await noticeCreated(world.discord);
  const messages = world.discord.created.length;

  // Act
  const archived = await world.factory.archiveRun(runId);

  // Assert
  assert(archived.ok, JSON.stringify(archived));
  await messageShows(
    world.discord,
    pending,
    /^🙋 \*\*Run #1 · Improve search\*\* needs input · ✅ resolved\n/,
  );
  await messageShows(world.discord, card, / · 🗄️ Archived · /);
  expect(world.discord.created).toHaveLength(messages);
});

it("while the thread's Project is revoked nothing accrues, and a regrant posts no notice for what happened meanwhile", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, card } = await chatStartedRun(world);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  await nativeRequestShown(world.world, worker);

  // Act
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [world.project.id, other.id]);

  // Assert
  // Once the card shows the request, the regrant was captured; a later Problem's notice comes
  // after anything the regrant would have posted.
  await messageShows(world.discord, card, /\n🙋 /);
  await settleUnresolved(world.world, worker);
  const notice = await noticeCreated(world.discord);
  expect(notice.content).toMatch(
    new RegExp(`^⚠️ ${REQUESTER_MENTION} \\*\\*Run #1 · Improve search\\*\\* has a Problem\\n`),
  );
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

it("a notice Discord proved deleted is not recreated when its matter resolves", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  await nativeRequestShown(world.world, worker);
  const notice = await noticeCreated(world.discord);
  world.discord.deleteMessage(notice.id);

  // Act
  await nativeRequestAnswered(world.world, worker);

  // Assert
  await world.discord.request("PATCH", new RegExp(`/messages/${notice.id}$`));
  // A later Problem orders its notice after anything the lost notice would have posted.
  await settleUnresolved(world.world, worker);
  const problem = await noticeCreated(world.discord, 2);
  expect(noticesIn(world.discord)).toStrictEqual([
    expect.objectContaining({ id: notice.id, deleted: true }),
    problem,
  ]);
});

it("a notice whose create Discord may have performed leaves Settings without a Retry once its matter resolved", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.faultMessages(...unproven("lost"));
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

it("the warned Retry of a notice Discord may not have created posts it once and starts nothing", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.faultMessages(...unproven("failed"));
  await nativeRequestShown(world.world, worker);
  const settings = await discordSettingsWhen(world.factory, (current) =>
    current.delivery.problems.some(
      (problem) => problem.purpose === "attention" && problem.state === "unknown",
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
  expectNoticePing(world.discord, notice);
  expect(await runsOf(world.factory)).toHaveLength(1);
  await discordSettingsWhen(world.factory, (current) => current.delivery.problems.length === 0);
});

it("Retry still delivers a notice without a ping if the requester lost Access while it waited", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker } = await chatStartedRun(world);
  world.discord.faultMessages(...unproven("failed"));
  await nativeRequestShown(world.world, worker);
  const settings = await discordSettingsWhen(world.factory, (current) =>
    current.delivery.problems.some((problem) => problem.purpose === "attention"),
  );
  await savedAccess(world.factory, [COLLABORATOR_ID], [world.project.id]);

  // Act
  const retried = await world.factory.retryChatDelivery({
    deliveryId: settings.delivery.problems[0]!.id,
    duplicateRiskAccepted: true,
  });

  // Assert
  assert(retried.ok, JSON.stringify(retried));
  const notice = await noticeCreated(world.discord);
  expect(notice.content).not.toContain(REQUESTER_MENTION);
  const posts = world.discord.requested("POST", MESSAGES);
  const initial = posts.at(-4)?.body;
  expect(initial).toEqual(
    expect.objectContaining({ nonce: expect.any(String), enforce_nonce: true }),
  );
  expect(posts.at(-1)?.body).toEqual(
    expect.objectContaining({
      nonce: (initial as { nonce: string }).nonce,
      enforce_nonce: true,
      content: notice.content,
      allowed_mentions: { parse: [] },
    }),
  );
});

it("a collaborator replying to an attention notice gives the model the Run ID without the notice text", async (c) => {
  // Arrange
  const world = await startingWorld(c);
  const { worker, runId } = await chatStartedRun(world);
  await nativeRequestShown(world.world, worker);
  const notice = await noticeCreated(world.discord);
  world.model.script({ text: "Reading it." });
  const requests = world.model.requests.length;

  // Act
  world.discord.deliver(noticeReply(notice));

  // Assert
  await world.model.requested(requests + 1);
  expect(userEnvelopes(world.model, requests).at(-1)).toEqual(
    expect.objectContaining({ referencedRun: runId }),
  );
  expect(JSON.stringify(requestMessages(world.model, requests))).not.toContain("has a T3 request");
});

it("a reply to a catch-up identifies the Run but Read Run respects the current Project grant", async (c) => {
  // Arrange
  const world = await startingWorld(c, fanOutFlow);
  const { runId } = await mattersWhileOff(world);
  await turnedOn(world.factory, world.discord, 2);
  const notice = await noticeCreated(world.discord);
  const other = await addedProject({ f: world.factory, h: world.harness }, "other");
  await savedAccess(world.factory, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);
  world.model.script(calls(readRun({ run: runId })), { text: "Not visible here." });
  const requests = world.model.requests.length;

  // Act
  world.discord.deliver(noticeReply(notice));

  // Assert
  await world.model.requested(requests + 2);
  expect(userEnvelopes(world.model, requests).at(-1)).toEqual(
    expect.objectContaining({ referencedRun: runId }),
  );
  expect(toolResults(world.model, requests + 1)).toEqual([
    expect.objectContaining({ error: "not_found" }),
  ]);
});

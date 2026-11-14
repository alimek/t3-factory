import { assert, expect, it } from "@effect/vitest";
import {
  answerCall,
  answeringWorld,
  clicked,
  confirmations,
  HUMAN_CONTEXT,
  occurrenceOf,
  statusCardsIn,
  proposed,
} from "./support/chat-actions.ts";
import { servingAgain } from "./support/chat-control.ts";
import { invocation, toolResults } from "./support/chat-conversation.ts";
import { addedProject, startedRun } from "./support/chat-runs.ts";

const ACCEPTED = "Confirmed. Factory accepted it; the receipt follows in this thread.";
const REJECTED =
  "Confirmed, but Factory did not accept it; the receipt in this thread explains why.";
const FEEDBACK = "Please handle the empty state too.";
const REQUEST = `request changes on #1: ${FEEDBACK}`;

it("a Human answer proposal reviews the Run, the exact occurrence with its complete context, the answer and the exact message with one requester button last, and answers nothing", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  const call = answerCall(world, {
    answer: "request-changes",
    message: FEEDBACK,
    messageSource: "requester-message",
  });

  // Act
  const button = await proposed(world, "600000000000000001", 6, call, REQUEST);

  // Assert
  const [header, context, answer, message, disclosure, confirmation] = world.discord.created;
  expect(header!.content).toContain("**Review: answer a Human step**");
  expect(header!.content).toContain(
    `**Run:** Run #1 “Improve search” in ${world.project.title} — \`${world.project.workspaceRoot}\``,
  );
  expect(header!.content).toContain(
    `**Human step:** Review (occurrence \`${world.occurrence.id}\`)`,
  );
  expect(header!.content).toContain("**Arrived from:** Entry worker, exit Done");
  expect(context!.content).toBe(`\`\`\`\n${HUMAN_CONTEXT}\n\`\`\``);
  expect(answer!.content).toContain("**Answer:** Request changes.");
  expect(answer!.content).toContain("exactly as written in your message");
  expect(message!.content).toBe(`\`\`\`\n${FEEDBACK}\n\`\`\``);
  expect(disclosure!.content).toContain("it never applies this answer to another occurrence");
  expect(confirmation!.content).toBe(
    "Confirm this answer: Request changes for the Human step “Review” in Run #1 “Improve search”.",
  );
  expect(confirmations(world.discord)).toHaveLength(1);
  expect(button).toMatch(/^factory-confirm:/);
  expect(
    (await occurrenceOf(world.factory, world.runId, world.occurrence.id)).occurrence.state,
  ).toBe("pending");
});

it("the requester's confirmation answers exactly the reviewed occurrence of a Run started in Factory and posts the receipt in the request thread without giving the Run an origin", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  const button = await proposed(world, "600000000000000001", 5, answerCall(world), "approve #1");

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ACCEPTED);
  const { occurrence, handoffs } = await occurrenceOf(
    world.factory,
    world.runId,
    world.occurrence.id,
  );
  expect(occurrence).toMatchObject({ state: "answered", exitId: "approve" });
  expect(handoffs).toHaveLength(1);
  await world.discord.createdMessages(6);
  expect(world.discord.created[5]!.content).toBe(
    `**Human answer accepted.** Factory accepted **Approve** for the Human step “Review” in Run #1 “Improve search”. The Flow continues from this answer; Factory shows its progress.\nOccurrence: \`${world.occurrence.id}\` · Run ID: \`${world.runId}\``,
  );
  expect(statusCardsIn(world.discord)).toStrictEqual([]);
});

it("an identical answer given in Factory meanwhile is not this action's: the confirmation is rejected and the receipt says nothing was answered", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  const button = await proposed(world, "600000000000000001", 5, answerCall(world), "approve #1");
  const elsewhere = await world.factory.answerHumanOccurrence(world.occurrence.id, {
    exitId: "approve",
  });
  assert(elsewhere.ok, JSON.stringify(elsewhere));

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(REJECTED);
  await world.discord.createdMessages(6);
  expect(world.discord.created[5]!.content).toBe(
    `**Human answer not accepted.** Factory did not answer the Human step “Review” in Run #1 “Improve search”: This occurrence was already answered or cancelled elsewhere.\nOccurrence: \`${world.occurrence.id}\` · Run ID: \`${world.runId}\`\nNothing was answered. If it still needs an answer, read the Run and ask for a new review.`,
  );
  expect(
    (await occurrenceOf(world.factory, world.runId, world.occurrence.id)).handoffs,
  ).toHaveLength(1);
});

it("two clicks racing on one Human answer review answer once and hand the answer on once", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  const button = await proposed(world, "600000000000000001", 5, answerCall(world), "approve #1");

  // Act
  const answers = await Promise.all([
    clicked(world.discord, button, "610000000000000001", 1),
    clicked(world.discord, button, "610000000000000002", 2),
  ]);

  // Assert
  expect(answers).toContain(ACCEPTED);
  const { occurrence, handoffs } = await occurrenceOf(
    world.factory,
    world.runId,
    world.occurrence.id,
  );
  expect(occurrence.state).toBe("answered");
  expect(handoffs).toHaveLength(1);
});

it("a Human answer review presented before a backend restart is confirmed once after it", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  const button = await proposed(world, "600000000000000001", 5, answerCall(world), "approve #1");
  await world.factory.close();
  const reopened = await world.open();
  await servingAgain(world.discord, 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ACCEPTED);
  const { occurrence, handoffs } = await occurrenceOf(reopened, world.runId, world.occurrence.id);
  expect(occurrence).toMatchObject({ state: "answered", exitId: "approve" });
  expect(handoffs).toHaveLength(1);
});

it("a broad request without one identified occurrence gets no review, and the model is told to ask which one", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  world.model.script(
    { toolCalls: [{ name: "answer_human", input: { run: "#1", answer: "approve" } }] },
    { text: "Which Human step?" },
  );

  // Act
  world.discord.deliver(invocation("600000000000000001", { content: "approve this Run" }));

  // Assert
  await world.discord.createdMessages(1);
  expect(confirmations(world.discord)).toHaveLength(0);
  expect(toolResults(world.model, 1)).toStrictEqual([
    {
      error: "invalid_arguments",
      message:
        "occurrenceId must name the one pending Human occurrence read_run lists. When several are pending, ask the requester which one; never answer more than one.",
    },
  ]);
});

it("Request changes without feedback gets no review and nothing is invented", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  world.model.script(answerCall(world, { answer: "request-changes" }), { text: "What changes?" });

  // Act
  world.discord.deliver(invocation("600000000000000001", { content: "request changes on #1" }));

  // Assert
  await world.discord.createdMessages(1);
  expect(confirmations(world.discord)).toHaveLength(0);
  expect(toolResults(world.model, 1)[0]!.message).toBe(
    "Request changes needs the requester's feedback. Ask for the exact text; never invent it.",
  );
});

it("a Human context beyond the 32,000-character review cannot be confirmed in chat and is never cut", async (c) => {
  // Arrange
  const world = await answeringWorld(c, "Review this change line by line.\n".repeat(1000));
  world.model.script(answerCall(world), { text: "Too long for chat." });

  // Act
  world.discord.deliver(invocation("600000000000000001", { content: "approve #1" }));

  // Assert
  await world.discord.createdMessages(1);
  expect(confirmations(world.discord)).toHaveLength(0);
  expect(toolResults(world.model, 1)[0]!.error).toBe("review_too_long");
});

it("an answer for a Run of a Project the thread does not permit is refused like a Run that does not exist", async (c) => {
  // Arrange
  const world = await answeringWorld(c);
  const other = await addedProject(world, "other-clone");
  const run = await startedRun(world, {
    requestId: "other-project-run",
    title: "Other work",
    createdAt: "2026-11-07T09:00:00.000Z",
    projectId: other.id,
  });
  world.model.script(answerCall(world, { run: run.id }), { text: "Not found." });

  // Act
  world.discord.deliver(invocation("600000000000000001", { content: `approve ${run.id}` }));

  // Assert
  await world.discord.createdMessages(1);
  expect(confirmations(world.discord)).toHaveLength(0);
  expect(toolResults(world.model, 1)[0]!.error).toBe("not_found");
});

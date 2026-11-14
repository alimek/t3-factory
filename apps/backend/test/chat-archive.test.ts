import { assert, expect, it } from "@effect/vitest";
import {
  archiveCall,
  archivingWorld,
  clicked,
  confirmations,
  lifecycleOf,
  statusCardsIn,
  proposed,
} from "./support/chat-actions.ts";
import { servingAgain } from "./support/chat-control.ts";
import { invocation, toolResults } from "./support/chat-conversation.ts";
import { addedProject, startedRun } from "./support/chat-runs.ts";
import { nextThreadInterrupt } from "./support/run-worker.ts";

const ACCEPTED = "✅ Confirmed (disabled)";
const REJECTED = "🚫 No longer valid (disabled)";

it("an Archive proposal reviews the Run with final archival, cancelled owed work and pending items, one interruption request and retained history, and archives nothing", async (c) => {
  // Arrange
  const world = await archivingWorld(c);

  // Act
  const button = await proposed(world, "600000000000000001", 2, archiveCall(), "stop #1");

  // Assert
  const [review, confirmation] = world.discord.created;
  expect(review!.content).toBe(
    [
      "🗄️ **Archive Run #1 · Improve search?**",
      `📁 ${world.project.title} · \`${world.project.workspaceRoot}\` · 🔀 ${world.flow.name} · 🟢 Active`,
      "⏳ Pending now: 0 Human occurrences, 0 Wait arrivals",
      "⚠️ Final: the Run can't be restored, reopened, settled or answered. Factory cancels the automatic work it still owes and its pending Human and Wait items, and asks T3 once to interrupt the workers without confirming they stop.",
      "↩️ Nothing is rolled back in the repository or worktree; the Run's history stays readable in Factory.",
    ].join("\n"),
  );
  expect(confirmation!.content).toMatch(
    /^🔒 Only the person who asked can confirm · expires <t:\d+:R>$/,
  );
  expect(button).toMatch(/^factory-confirm:/);
  expect(await lifecycleOf(world.factory, world.runId)).toBe("active");
});

it("the requester's confirmation archives exactly the reviewed Run started in Factory, requests its worker's interruption once and posts the receipt in the request thread without giving the Run an origin", async (c) => {
  // Arrange
  const world = await archivingWorld(c);
  const button = await proposed(world, "600000000000000001", 2, archiveCall(), "archive #1");
  const interrupt = nextThreadInterrupt(world.t3);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ACCEPTED);
  expect(await lifecycleOf(world.factory, world.runId)).toBe("archived");
  await interrupt;
  expect(world.t3.threadStops).toHaveLength(1);
  await world.discord.createdMessages(3);
  expect(world.discord.created[2]!.content).toBe(
    "✅ **Run #1 archived** — Improve search\nOwed automatic work and pending Human/Wait items cancelled · T3 asked once to interrupt workers (not confirmed) · nothing rolled back",
  );
  expect(statusCardsIn(world.discord)).toStrictEqual([]);
});

it("a Run archived in Factory meanwhile is not this action's Archive: the confirmation is rejected and requests no further interruption", async (c) => {
  // Arrange
  const world = await archivingWorld(c);
  const button = await proposed(world, "600000000000000001", 2, archiveCall(), "archive #1");
  const interrupt = nextThreadInterrupt(world.t3);
  assert((await world.factory.archiveRun(world.runId)).ok);
  await interrupt;

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(REJECTED);
  await world.discord.createdMessages(3);
  expect(world.discord.created[2]!.content).toBe(
    "❌ **Archive not accepted** — Run #1 · Improve search\nThis Run was already archived elsewhere.",
  );
  expect(world.t3.threadStops).toHaveLength(1);
});

it("two clicks racing on one Archive review archive once and request interruption once", async (c) => {
  // Arrange
  const world = await archivingWorld(c);
  const button = await proposed(world, "600000000000000001", 2, archiveCall(), "archive #1");
  const interrupt = nextThreadInterrupt(world.t3);

  // Act
  const answers = await Promise.all([
    clicked(world.discord, button, "610000000000000001", 1),
    clicked(world.discord, button, "610000000000000002", 2),
  ]);

  // Assert
  expect(answers).toContain(ACCEPTED);
  await interrupt;
  expect(world.t3.threadStops).toHaveLength(1);
  expect(await lifecycleOf(world.factory, world.runId)).toBe("archived");
});

it("an Archive review presented before a backend restart is confirmed once after it", async (c) => {
  // Arrange
  const world = await archivingWorld(c);
  const button = await proposed(world, "600000000000000001", 2, archiveCall(), "archive #1");
  await world.factory.close();
  const reopened = await world.open();
  await servingAgain(world.discord, 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000001", 1);

  // Assert
  expect(answer).toBe(ACCEPTED);
  expect(await lifecycleOf(reopened, world.runId)).toBe("archived");
});

it("after a restart that interrupted an accepted Archive's receipt, the repeated click reports the accepted result and archives or interrupts nothing again", async (c) => {
  // Arrange
  const world = await archivingWorld(c);
  const button = await proposed(world, "600000000000000001", 2, archiveCall(), "archive #1");
  const interrupt = nextThreadInterrupt(world.t3);
  world.discord.faultMessages("held");
  await clicked(world.discord, button, "610000000000000001", 1);
  await world.discord.request("POST", /^\/api\/v10\/channels\/\d+\/messages$/, 3);
  await interrupt;
  await world.factory.close();
  const reopened = await world.open();
  await servingAgain(world.discord, 2);

  // Act
  const answer = await clicked(world.discord, button, "610000000000000002", 2);

  // Assert
  expect(answer).toBe(
    "You already confirmed this review. Factory archived Run #1 · Improve search.",
  );
  expect(world.t3.threadStops).toHaveLength(1);
  const settings = await reopened.getDiscordSettings();
  assert(settings.ok);
  expect(settings.value.delivery.problems).toStrictEqual([
    expect.objectContaining({ purpose: "receipt", state: "unknown" }),
  ]);
});

it("an Archive of a Run in a Project the thread does not permit is refused like a Run that does not exist", async (c) => {
  // Arrange
  const world = await archivingWorld(c);
  const other = await addedProject(world, "other-clone");
  const run = await startedRun(world, {
    requestId: "other-project-run",
    title: "Other work",
    createdAt: "2026-11-07T09:00:00.000Z",
    projectId: other.id,
  });
  world.model.script(archiveCall({ run: run.id }), { text: "Not found." });

  // Act
  world.discord.deliver(invocation("600000000000000001", { content: `stop ${run.id}` }));

  // Assert
  await world.discord.createdMessages(1);
  expect(confirmations(world.discord)).toHaveLength(0);
  expect(toolResults(world.model, 1)[0]!.error).toBe("not_found");
  expect(await lifecycleOf(world.factory, run.id)).toBe("active");
});

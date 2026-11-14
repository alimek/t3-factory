import { assert, expect, it } from "@effect/vitest";
import { ALLOWED_CHANNEL, discordBot, discordGuild } from "./support/chat-control.ts";
import {
  answered,
  invocation,
  posted,
  savedAccess,
  COLLABORATOR_ID,
  THREAD,
  toolResults,
} from "./support/chat-conversation.ts";
import { PARTICIPANT_ID, resetCommandEvent } from "./support/controlled-discord.ts";
import {
  addedProject,
  calls,
  findRuns,
  readRun,
  remoteRunConversation,
  runConversation,
  runIdentity,
  startedRun,
  startedRuns,
} from "./support/chat-runs.ts";
import {
  humanReviewFlow,
  resultReleasedToHumanReview,
  resultReported,
  workerAtWork,
  workingReported,
} from "./support/scenarios.ts";

const ORIGINAL = /^\/api\/v10\/webhooks\/\d+\/[^/]+\/messages\/%40original$/;
const LONG_REQUEST = "x".repeat(7900);

it("Find Runs returns ID, number, title, Project and state of the permitted Projects' Runs, including Runs started in Factory", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const first = await startedRun(fixture, {
    requestId: "search-first",
    title: "Improve search",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const second = await startedRun(fixture, {
    requestId: "search-second",
    title: "Improve search ranking",
    createdAt: "2026-11-07T09:00:00.000Z",
  });
  assert((await fixture.f.snoozeRun(second.id)).ok);
  fixture.model.script(calls(findRuns({ text: "search" })), { text: "Two Runs." });

  // Act
  await answered(fixture.discord, "300000000000001001", 1);

  // Assert
  expect(toolResults(fixture.model, 1)).toStrictEqual([
    {
      order: "newest first",
      matching: 2,
      runs: [
        runIdentity(second, fixture.project, "snoozed"),
        runIdentity(first, fixture.project, "active"),
      ],
      next: null,
    },
  ]);
});

it("Find Runs leaves Archived Runs out unless they are asked for", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const kept = await startedRun(fixture, {
    requestId: "kept",
    title: "Kept work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const archived = await startedRun(fixture, {
    requestId: "archived",
    title: "Archived work",
    createdAt: "2026-11-07T09:00:00.000Z",
  });
  assert((await fixture.f.archiveRun(archived.id)).ok);
  fixture.model.script(calls(findRuns(), findRuns({ includeArchived: true })), { text: "Done." });

  // Act
  await answered(fixture.discord, "300000000000001002", 1);

  // Assert
  const [standard, withArchived] = toolResults(fixture.model, 1);
  expect(standard!.runs).toStrictEqual([runIdentity(kept, fixture.project)]);
  expect(withArchived!.runs).toStrictEqual([
    runIdentity(archived, fixture.project, "archived"),
    runIdentity(kept, fixture.project),
  ]);
});

it("an exact Run number reaches an Archived Run", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const archived = await startedRun(fixture, {
    requestId: "archived",
    title: "Archived work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  assert((await fixture.f.archiveRun(archived.id)).ok);
  fixture.model.script(calls(findRuns({ reference: `#${archived.number}` })), { text: "Found." });

  // Act
  await answered(fixture.discord, "300000000000001003", 1);

  // Assert
  expect(toolResults(fixture.model, 1)).toStrictEqual([
    { runs: [runIdentity(archived, fixture.project, "archived")] },
  ]);
});

it("a Run of a Project the thread does not permit is not found, even by its exact ID or number", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const other = await addedProject(fixture, "other");
  const hidden = await startedRun(fixture, {
    requestId: "hidden",
    title: "Hidden work",
    createdAt: "2026-11-07T08:00:00.000Z",
    projectId: other.id,
  });
  fixture.model.script(
    calls(
      findRuns({ text: "Hidden" }),
      findRuns({ reference: hidden.id }),
      readRun({ run: `#${hidden.number}` }),
      readRun({ run: "no-such-run" }),
    ),
    { text: "Nothing." },
  );

  // Act
  await answered(fixture.discord, "300000000000001004", 1);

  // Assert
  const [search, reference, read, missing] = toolResults(fixture.model, 1);
  expect(search).toMatchObject({ matching: 0, runs: [] });
  expect(reference).toMatchObject({ runs: [] });
  expect(read).toStrictEqual(missing);
  expect(read).toMatchObject({ error: "not_found" });
});

it("Runs of independent clones with the same title are told apart by number and repository path", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const first = await addedProject(fixture, "a/app");
  const second = await addedProject(fixture, "b/app");
  await savedAccess(fixture.f, [PARTICIPANT_ID, COLLABORATOR_ID], [first.id, second.id]);
  const older = await startedRun(fixture, {
    requestId: "first-clone",
    title: "Improve search",
    createdAt: "2026-11-07T08:00:00.000Z",
    projectId: first.id,
  });
  const newer = await startedRun(fixture, {
    requestId: "second-clone",
    title: "Improve search",
    createdAt: "2026-11-07T09:00:00.000Z",
    projectId: second.id,
  });
  fixture.model.script(calls(findRuns({ text: "Improve search" })), { text: "Which one?" });

  // Act
  await answered(fixture.discord, "300000000000001005", 1);

  // Assert
  expect(toolResults(fixture.model, 1)[0]!.runs).toStrictEqual([
    runIdentity(newer, second),
    runIdentity(older, first),
  ]);
});

it("continuing a search reaches every Run that already matched while new Runs arrive, and a fresh search includes them", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const existing = await startedRuns(fixture, 11, "Existing");
  fixture.model.script(calls(findRuns()));
  const continuation = fixture.model.held();
  fixture.model.script({ text: "All of them." });
  fixture.discord.deliver(invocation("300000000000001006"));
  await fixture.model.requested(2);
  const [first] = toolResults(fixture.model, 1);
  await startedRuns(fixture, 2, "Arrived", 30);

  // Act
  continuation.release(calls(findRuns({ continuation: first!.next }), findRuns()));
  await posted(fixture.discord, 1);

  // Assert
  const [, rest, fresh] = toolResults(fixture.model, 2);
  expect(
    [...(first!.runs as { id: string }[]), ...(rest!.runs as { id: string }[])].map(
      (run) => run.id,
    ),
  ).toStrictEqual(existing.map((run) => run.id).reverse());
  expect(rest!.next).toBeNull();
  expect(fresh).toMatchObject({ matching: 13 });
});

it("Read Run describes a Run with the definitions it captured after its Flow was edited", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const run = await startedRun(fixture, {
    requestId: "captured",
    title: "Captured work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const saved = await fixture.f.updateFlow(fixture.flow.id, {
    name: "Edited Flow",
    graph: {
      ...fixture.flow.graph,
      blocks: fixture.flow.graph.blocks.map((block) => ({ ...block, name: "Renamed worker" })),
    },
    expectedRevision: fixture.flow.revision,
  });
  assert(saved.ok, JSON.stringify(saved));
  fixture.model.script(calls(readRun({ run: `#${run.number}` })), { text: "Read." });

  // Act
  await answered(fixture.discord, "300000000000001007", 1);

  // Assert
  const [overview] = toolResults(fixture.model, 1);
  expect(overview).toMatchObject({
    run: {
      id: run.id,
      flow: {
        name: "Single worker",
        capturedRevision: fixture.flow.revision,
        latestSavedRevision: saved.value.revision,
      },
    },
    blocks: { total: 1, entries: [{ blockId: "worker", name: "Entry worker", kind: "agent" }] },
  });
});

it("a pending Human occurrence names its arrival and its complete context is readable page by page beyond the review limit", async (c) => {
  // Arrange
  const fixture = await runConversation(c, humanReviewFlow);
  const worker = await workerAtWork(fixture.world, fixture.input);
  await resultReported(fixture.world, worker, {
    message: "Review this change line by line.\n".repeat(1000),
  });
  const review = await resultReleasedToHumanReview(fixture.world, worker);
  const run = await fixture.f.getRun(worker.runId);
  assert(run.ok);
  fixture.model.script(calls(readRun({ run: worker.runId })));
  const sections = fixture.model.held();
  fixture.model.script({ text: "Read it all." });
  fixture.discord.deliver(invocation("300000000000001008"));
  await fixture.model.requested(2);
  const [overview] = toolResults(fixture.model, 1);
  const occurrence = (overview!.humanOccurrences as { entries: Record<string, unknown>[] })
    .entries[0]!;
  const section = (occurrence.context as { section: string }).section;
  const read = overview!.read;

  // Act
  sections.release(
    calls(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((page) => readRun({ read, section, page }))),
  );
  await posted(fixture.discord, 1);

  // Assert
  const pages = toolResults(fixture.model, 2).slice(1);
  expect(occurrence).toMatchObject({
    occurrenceId: review.occurrence.id,
    block: "Review",
    arrival: { from: "Entry worker", exit: "Done" },
    context: { characters: 33000, pages: 9 },
  });
  expect(pages.map((page) => page.text).join("")).toBe(
    run.value.humanOccurrences.find((entry) => entry.id === review.occurrence.id)!.context,
  );
});

it("a Run read handle is no longer usable after /factory reset", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const run = await startedRun(fixture, {
    requestId: "reset",
    title: "Reset work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  fixture.model.script(calls(readRun({ run: run.id })), { text: "Read." });
  await answered(fixture.discord, "300000000000001009", 1);
  const read = toolResults(fixture.model, 1)[0]!.read;
  fixture.discord.deliver(
    resetCommandEvent({
      bot: discordBot,
      guildId: discordGuild.id,
      channel: { id: THREAD, parentId: ALLOWED_CHANNEL, private: false },
      id: "300000000000001010",
    }),
  );
  await fixture.discord.request("PATCH", ORIGINAL);
  fixture.model.script(calls(readRun({ read, section: "prompt" })), { text: "Gone." });

  // Act
  await answered(fixture.discord, "300000000000001011", 2);

  // Assert
  expect(toolResults(fixture.model, 3)).toStrictEqual([
    { error: "expired_handle", message: expect.any(String) },
  ]);
});

it("a search continuation is no longer usable once its turn was evicted", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  await startedRuns(fixture, 11, "Existing");
  fixture.model.script(calls(findRuns()), { text: "Eleven." });
  await answered(fixture.discord, "300000000000001012", 1);
  const next = toolResults(fixture.model, 1)[0]!.next;
  await answered(fixture.discord, "300000000000001013", 2, { content: LONG_REQUEST });
  await answered(fixture.discord, "300000000000001014", 3, { content: LONG_REQUEST });
  await answered(fixture.discord, "300000000000001015", 4, { content: LONG_REQUEST });
  await answered(fixture.discord, "300000000000001016", 5, { content: LONG_REQUEST });
  fixture.model.script(calls(findRuns({ continuation: next })), { text: "Gone." });

  // Act
  await answered(fixture.discord, "300000000000001017", 6);

  // Assert
  expect(toolResults(fixture.model, 7).at(-1)).toStrictEqual({
    error: "expired_handle",
    message: expect.any(String),
  });
});

it("a section that changed since the Run overview listed it is reported stale rather than mixed", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const worker = await workerAtWork(fixture.world, fixture.input);
  await workingReported(fixture.world, worker, "Opened PR #42.");
  fixture.model.script(calls(readRun({ run: worker.runId })));
  const section = fixture.model.held();
  fixture.model.script({ text: "Changed." });
  fixture.discord.deliver(invocation("300000000000001018"));
  await fixture.model.requested(2);
  const read = toolResults(fixture.model, 1)[0]!.read;
  await workingReported(fixture.world, worker, "CI is green; merging.");

  // Act
  section.release(calls(readRun({ read, section: "working:worker" })));
  await posted(fixture.discord, 1);

  // Assert
  expect(toolResults(fixture.model, 2)[1]).toStrictEqual({
    error: "stale",
    message: expect.any(String),
  });
});

it("a Run read is not published once its Project is no longer granted in the channel", async (c) => {
  // Arrange
  const fixture = await runConversation(c);
  const other = await addedProject(fixture, "other");
  const run = await startedRun(fixture, {
    requestId: "revoked",
    title: "Revoked work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  fixture.model.script(calls(readRun({ run: run.id })));
  const reply = fixture.model.held();
  fixture.discord.deliver(invocation("300000000000001019"));
  await fixture.model.requested(2);
  await savedAccess(fixture.f, [PARTICIPANT_ID, COLLABORATOR_ID], [other.id]);

  // Act
  reply.release({ text: `Run #${run.number} is Revoked work.` });
  const replies = await answered(fixture.discord, "300000000000001020", 1);

  // Assert
  expect(replies).toStrictEqual(["OK"]);
});

it("reading a Factory-started Run through chat leaves approved-client Run views without Discord identifiers", async (c) => {
  // Arrange
  const fixture = await remoteRunConversation(c);
  const run = await startedRun(fixture, {
    requestId: "remote",
    title: "Remote work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  fixture.model.script(calls(readRun({ run: run.id })), { text: "Read." });

  // Act
  await answered(fixture.discord, "300000000000001021", 1);

  // Assert
  const views = [
    await fixture.approvedRead(`/api/runs/${run.id}`),
    await fixture.approvedRead("/api/run-navigation"),
  ].join("\n");
  expect(views).toContain(run.id);
  expect(
    [THREAD, ALLOWED_CHANNEL, discordGuild.id, discordBot.applicationId, PARTICIPANT_ID].filter(
      (id) => views.includes(id),
    ),
  ).toStrictEqual([]);
});

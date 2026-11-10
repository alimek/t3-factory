import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { unnumberedRun } from "./support/navigation.ts";
import { repositoryFactsObserved, twoRunsOfOneFlow, workerLaunched } from "./support/scenarios.ts";

const repository = {
  branch: "feature/search",
  pullRequests: [
    {
      host: "github.com",
      repository: "example/search",
      number: 42,
      url: "https://github.com/example/search/pull/42",
      state: "open" as const,
    },
  ],
};

/** The second of two Runs of one Flow, created a minute after the first. */
const secondStart = {
  requestId: "second",
  input: "Second title\nHidden body",
  title: "Second title",
  createdAt: "2026-11-07T08:01:00.000Z",
};

it("unchanged worker observations change neither navigation metadata nor the last activity time", async (c) => {
  // Arrange
  const { f, world, input } = await prepared(c);
  await repositoryFactsObserved(world, await workerLaunched(world, input), repository);
  const listed = await f.listRunNavigation();
  assert(listed.ok);
  const navigation = listed.value;

  // Act
  assert((await f.reconcileRuns()).ok);

  // Assert
  expect(await f.listRunNavigation()).toStrictEqual({ ok: true, value: navigation });
});

it("worker branches and linked pull requests remain available after restarting Factory", async (c) => {
  // Arrange
  const { h, f, t3, world, input } = await prepared(c);
  const launched = await workerLaunched(world, input);
  const { runId, threadId } = await repositoryFactsObserved(world, launched, repository);
  const before = await f.listRunNavigation();
  assert(before.ok);
  const navigation = before.value;
  await f.close();

  // Act
  const restarted = await h.open({ t3, connectionRetryMs: 60_000 });
  c.onTestFinished(() => restarted.close());

  // Assert
  const run = await restarted.getRun(runId);
  assert(run.ok);
  expect(run.value.repositories).toMatchObject([{ threadId, ...repository }]);
  const listed = await restarted.listRunNavigation();
  assert(listed.ok);
  expect(listed.value[0]?.repositories).toStrictEqual(run.value.repositories);
  expect(listed.value[0]?.lastActivityAt).toBe(navigation[0]?.lastActivityAt);
});

it("an unavailable observation preserves last known worker repositories and marks them stale", async (c) => {
  // Arrange
  const { f, t3, world, input } = await prepared(c);
  const launched = await workerLaunched(world, input);
  const { runId } = await repositoryFactsObserved(world, launched, repository);
  t3.available = false;

  // Act
  assert((await f.reconcileRuns()).ok);

  // Assert
  const run = await f.getRun(runId);
  assert(run.ok);
  expect(run.value.repositories).toMatchObject([{ ...repository, freshness: "stale" }]);
});

it("a Start with an over-long title creates no Run", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);

  // Act
  const result = await f.startRun({ ...input, title: "x".repeat(501) });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues.map((issue) => issue.path)).toStrictEqual(["title"]);
  expect(await f.listRunNavigation()).toStrictEqual({ ok: true, value: [] });
});

it("a Start with a non-canonical creation time creates no Run", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);

  // Act
  const result = await f.startRun({ ...input, createdAt: "2026-11-07 08:00" });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues.map((issue) => issue.path)).toStrictEqual(["createdAt"]);
  expect(await f.listRunNavigation()).toStrictEqual({ ok: true, value: [] });
});

it("a started draft keeps its chosen title and creation order after restart", async (c) => {
  // Arrange
  const { h, f, t3, input } = await prepared(c);
  const newer = await f.startRun({
    ...input,
    requestId: "newer-draft",
    title: "Newer draft",
    createdAt: "2026-11-07T09:00:00.000Z",
  });
  assert(newer.ok);
  const older = await f.startRun({
    ...input,
    title: "  Chosen draft title  ",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  assert(older.ok);
  await f.close();
  const restarted = await h.open({ t3, connectionRetryMs: 60_000 });
  c.onTestFinished(() => restarted.close());

  // Act
  const result = await restarted.listRunNavigation();

  // Assert
  assert(result.ok);
  expect(result.value.map(({ id, title, createdAt }) => ({ id, title, createdAt }))).toStrictEqual([
    { id: newer.value.id, title: "Newer draft", createdAt: "2026-11-07T09:00:00.000Z" },
    { id: older.value.id, title: "Chosen draft title", createdAt: "2026-11-07T08:00:00.000Z" },
  ]);
  expect(older.value.startedAt).not.toBe("2026-11-07T08:00:00.000Z");
});

it("Runs created at the same time are ordered by their Start request keys", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);
  assert((await f.startRun({ ...input, requestId: "b-draft" })).ok);
  assert((await f.startRun({ ...input, requestId: "a-draft" })).ok);

  // Act
  const result = await f.listRunNavigation();

  // Assert
  assert(result.ok);
  expect(result.value.map((entry) => entry.creationKey)).toStrictEqual(["a-draft", "b-draft"]);
});

it("renaming a Run trims its title without changing its sibling or its Task", async (c) => {
  // Arrange
  const { f, world, input } = await prepared(c);
  const { first, second } = await twoRunsOfOneFlow(world, input, { ...input, ...secondStart });

  // Act
  const renamed = await f.renameRun(first.id, { title: "  Independent name  " });

  // Assert
  assert(renamed.ok);
  expect(renamed.value.title).toBe("Independent name");
  expect(renamed.value.definitions).toStrictEqual(first.definitions);
  expect(renamed.value.events).toStrictEqual(first.events);
  expect(renamed.value.input).toBe(first.input);
  expect(renamed.value.task.title).toBe(first.task.title);
  const other = await f.getRun(second.id);
  assert(other.ok);
  expect(other.value.title).toBe("Second title");
});

it("a whitespace-only Run title is rejected", async (c) => {
  // Arrange
  const { f, world, input } = await prepared(c);
  const { first } = await twoRunsOfOneFlow(world, input, { ...input, ...secondStart });

  // Act
  const result = await f.renameRun(first.id, { title: " \t " });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
});

it("global navigation leaves out an archived Run and keeps the others in creation order", async (c) => {
  // Arrange
  const { f, input, world } = await prepared(c);
  const { first, second } = await twoRunsOfOneFlow(world, input, { ...input, ...secondStart });
  await f.renameRun(first.id, { title: "Latest activity on oldest Run" });
  const third = await f.startRun({
    ...input,
    requestId: "third",
    title: "Third title",
    input: "Third title",
    createdAt: "2026-11-07T08:02:00.000Z",
  });
  assert(third.ok);
  assert((await f.archiveRun(second.id)).ok);

  // Act
  const result = await f.listRunNavigation();

  // Assert
  assert(result.ok);
  expect(result.value.map((run) => run.id)).toStrictEqual([third.value.id, first.id]);
  expect(result.value.map((run) => run.lifecycle)).toStrictEqual(["active", "active"]);
});

it("snoozing an open Run leaves execution, attention and history unchanged", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  const before = await f.getRun(started.value.id);

  // Act
  const result = await f.snoozeRun(started.value.id);

  // Assert
  expect(result).toStrictEqual({ ok: true, value: { snoozed: true, woke: false } });
  expect(await f.getRun(started.value.id)).toStrictEqual(before);
  const navigation = await f.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value[0]?.presentation).toStrictEqual({ snoozed: true, woke: false });
});

it("navigation identifies a started Run with the same number as Run detail", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);
  const started = await f.startRun(input);
  assert(started.ok);
  const detail = await f.getRun(started.value.id);
  assert(detail.ok);

  // Act
  const navigation = await f.listRunNavigation();

  // Assert
  assert(navigation.ok);
  expect(detail.value.number).toBeGreaterThan(0);
  expect(navigation.value[0]?.number).toBe(detail.value.number);
});

it("navigation and Run detail preserve an absent stored Run number", async (c) => {
  // Arrange
  const { f, runId } = await unnumberedRun(c);

  // Act
  const navigation = await f.listRunNavigation();

  // Assert
  assert(navigation.ok);
  expect(navigation.value[0]?.number).toBeNull();
  const detail = await f.getRun(runId);
  assert(detail.ok);
  expect(detail.value.number).toBeNull();
});

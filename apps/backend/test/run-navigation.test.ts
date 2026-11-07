import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { siblingRuns } from "./support/navigation.ts";

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
  const { f, first, second } = await siblingRuns(c);

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
  const { f, first } = await siblingRuns(c);

  // Act
  const result = await f.renameRun(first.id, { title: " \t " });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
});

it("global navigation keeps creation order and only confirmed whole-Run closure", async (c) => {
  // Arrange
  const { f, first, second } = await siblingRuns(c);
  await f.renameRun(first.id, { title: "Latest activity on oldest Run" });
  await f.stopRun(second.id);

  // Act
  const result = await f.listRunNavigation();

  // Assert
  assert(result.ok);
  expect(result.value.map((run) => run.id)).toStrictEqual([second.id, first.id]);
  expect(result.value[0]?.outcome).toBe(null);
  assert(result.value[0]?.stopRequestedAt);
  expect(result.value[1]?.outcome).toBe("stopped");
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

it("closed Runs cannot be snoozed", async (c) => {
  // Arrange
  const { f, first } = await siblingRuns(c);

  // Act
  const result = await f.snoozeRun(first.id);

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("conflict");
});

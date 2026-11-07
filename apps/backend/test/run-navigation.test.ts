import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { siblingRuns } from "./support/navigation.ts";

it("a Run takes its bounded title from the first non-empty prompt line", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);
  const prompt = " \n\t\r\n  " + "x".repeat(501) + "\nFull input retained";

  // Act
  const result = await f.startRun({ ...input, input: prompt });

  // Assert
  assert(result.ok);
  const navigation = await f.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value[0]?.title).toBe("x".repeat(500));
  expect(result.value.input).toBe(prompt);
});

it("renaming a Run trims its title without changing its sibling or its Task", async (c) => {
  // Arrange
  const { f, first, second } = await siblingRuns(c);

  // Act
  const renamed = await f.renameRun(first.id, { title: "  Independent name  " });

  // Assert
  assert(renamed.ok);
  expect(renamed.value.title).toBe("Independent name");
  expect(renamed.value.snapshot).toStrictEqual(first.snapshot);
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
  expect(result.value[1]?.createdAt).toBe(first.startedAt);
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

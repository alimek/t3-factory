import type { RunNavigationEntry } from "@t3-factory/contracts";
import { expect, it } from "vite-plus/test";
import { navigationScope } from "../src/live/navigation.ts";

it("navigation changes replace rows, remove archived Runs and retain backend creation order", () => {
  // Arrange
  const older: RunNavigationEntry = {
    id: "older",
    number: 1,
    title: "Older Run",
    createdAt: "2026-11-07T12:00:00.000Z",
    creationKey: "first",
    lastActivityAt: "2026-11-07T12:00:00.000Z",
    flowName: "Flow",
    repositories: [],
    project: {
      id: "project",
      title: "Project",
      workspaceRoot: "/project",
      availability: "available",
    },
    lifecycle: "active",
    blocks: [],
    presentation: { snoozed: false, woke: false },
    attention: { needsInput: false, problem: false, matters: [] },
  };
  const removed = { ...older, id: "archived" };
  const renamed = { ...older, title: "Renamed Run", lifecycle: "settled" as const };
  const uppercase = {
    ...older,
    id: "uppercase",
    createdAt: "2026-11-08T12:00:00.000Z",
    creationKey: "Z",
  };
  const lowercase = { ...uppercase, id: "lowercase", creationKey: "a" };
  const unchanged = { ...uppercase, id: "unchanged", creationKey: "0" };
  const rows = [unchanged, removed, older];

  // Act
  const result = navigationScope.apply(rows, {
    _tag: "changed",
    upserts: [lowercase, renamed, uppercase],
    removals: [removed.id],
  });

  // Assert
  expect(result).toStrictEqual([unchanged, uppercase, lowercase, renamed]);
  expect(rows).toStrictEqual([unchanged, removed, older]);
});

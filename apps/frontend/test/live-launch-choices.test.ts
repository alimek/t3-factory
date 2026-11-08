import type { FlowDraft, LaunchChoices } from "@t3-factory/contracts";
import { expect, it } from "vite-plus/test";
import { launchChoicesScope } from "../src/live/launch-choices.ts";

const flow = (id: string, createdAt: string): FlowDraft => ({
  id,
  name: `Flow ${id}`,
  revision: 1,
  graph: {
    blocks: [],
    connections: [],
    flowInput: { position: { x: 0, y: 0 }, targetBlockIds: [] },
  },
  createdAt,
  updatedAt: createdAt,
  readiness: { ready: false, issues: [] },
});

it("Flow changes replace Flows by id, drop removed ones and keep the backend order", () => {
  // Arrange
  const older = flow("older", "2026-11-07T12:00:00.000Z");
  const removed = flow("removed", "2026-11-07T13:00:00.000Z");
  const unchanged = flow("B", "2026-11-08T12:00:00.000Z");
  const created = flow("a", "2026-11-08T12:00:00.000Z");
  const ready = { ...older, revision: 2, readiness: { ready: true, issues: [] } };
  const catalog = { projects: [], selectedProjectId: null, problem: null };
  const choices: LaunchChoices = { catalog, flows: [unchanged, removed, older] };

  // Act
  const result = launchChoicesScope.apply(choices, {
    _tag: "changed",
    flows: { upserts: [ready, created], removals: [removed.id] },
  });

  // Assert
  expect(result).toStrictEqual({ catalog, flows: [unchanged, created, ready] });
  expect(choices.flows).toStrictEqual([unchanged, removed, older]);
});

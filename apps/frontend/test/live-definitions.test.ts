import type { AgentDefinition, StudioDefinitions } from "@t3-factory/contracts";
import { expect, it } from "vite-plus/test";
import { definitionsScope } from "../src/live/scopes.ts";
import { savedAgent } from "./support/agent-draft.ts";
import { savedFlow } from "./support/studio-definitions.ts";

const agent = (id: string, updatedAt: string): AgentDefinition =>
  savedAgent({ id, name: `Agent ${id}`, updatedAt });

it("Studio definition changes replace Agents and Flows by id, drop removed ones and keep the backend order", () => {
  // Arrange
  const older = agent("older", "2026-11-07T12:00:00.000Z");
  const removed = agent("removed", "2026-11-07T13:00:00.000Z");
  const flow = savedFlow("Review");
  const definitions: StudioDefinitions = { agents: [removed, older], flows: [flow] };
  const saved = { ...older, revision: 4, updatedAt: "2026-11-09T12:00:00.000Z" };
  const readinessOnly = { ...flow, readiness: { ready: false, issues: [] } };

  // Act
  const result = definitionsScope.apply(definitions, {
    _tag: "changed",
    agents: { upserts: [saved], removals: [removed.id] },
    flows: { upserts: [readinessOnly], removals: [] },
  });

  // Assert
  expect(result).toStrictEqual({ agents: [saved], flows: [readinessOnly] });
  expect(definitions.agents).toStrictEqual([removed, older]);
});

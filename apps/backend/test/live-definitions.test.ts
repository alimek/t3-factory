import { assert, expect, it } from "@effect/vitest";
import type { DefinitionsLiveMessage } from "@t3-factory/contracts";
import { flowWithAgent } from "./support/domain-setup.ts";
import { subscribe } from "./support/live.ts";

it("a removed Agent leaves the definitions Studio subscribes to without another read", async (c) => {
  // Arrange
  const { factory, created, agent } = await flowWithAgent(c);
  assert(created.ok);
  const definitions = subscribe(c, factory.live.watchDefinitions());
  await definitions.until((messages) => messages.length > 0);

  // Act
  const removed = await factory.removeAgent(agent.id);

  // Assert
  assert(removed.ok);
  const delivered = await definitions.until((messages) => messages.length > 1);
  expect(delivered).toStrictEqual([
    {
      _tag: "snapshot",
      versions: {
        flows: [{ id: created.value.id, revision: 1 }],
        agents: [{ id: agent.id, revision: 1 }],
      },
    },
    {
      _tag: "changed",
      versions: { flows: [{ id: created.value.id, revision: 1 }], agents: [] },
    },
  ] satisfies DefinitionsLiveMessage[]);
});

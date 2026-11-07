import { assert, expect, it } from "@effect/vitest";
import { frozenRevisions, snapshotDefinitions } from "./support/frozen-revisions.ts";
import { prepared } from "./support/prepared-runner.ts";

it("each Start of the same Flow revision freezes the Agent revision current when it started", async (c) => {
  // Arrange
  const { h, f, input, agent } = await prepared(c);
  const first = await f.startRun(input);
  assert(first.ok);
  const edited = await f.updateAgent(agent.id, {
    ...agent,
    prompt: "Follow repository instructions and update the changelog.",
    expectedRevision: agent.revision,
  });
  assert(edited.ok);

  // Act
  const second = await f.startRun({ ...input, requestId: "start-two" });

  // Assert
  assert(second.ok);
  const before = frozenRevisions(h.databasePath, first.value.id);
  const after = frozenRevisions(h.databasePath, second.value.id);
  expect(before).toMatchObject(snapshotDefinitions(first.value.snapshot));
  expect(after).toMatchObject(snapshotDefinitions(second.value.snapshot));
  expect(before.agents.map((frozen) => frozen.revision)).toStrictEqual([1]);
  expect(after.agents.map((frozen) => frozen.revision)).toStrictEqual([2]);
  expect(after.flow?.revision).toBe(before.flow?.revision);
  expect(after.activations).toMatchObject([{ agentId: agent.id, revision: 2 }]);
});

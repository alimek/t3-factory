import { assert, expect, it } from "@effect/vitest";
import {
  openFactoryWithApprovedT3,
  readAgentAfterRestart,
  sampleAgentInput,
} from "./support/domain-setup.ts";

const reviewExits = [
  { id: "pass", name: "pass", description: "The change is ready.", messageRequired: false },
  { id: "fail", name: "fail", description: "Corrections are needed.", messageRequired: true },
];

it("saved Agent definitions survive restart with execution settings and exits intact", async (context) => {
  // Arrange
  const { harness, factory } = await openFactoryWithApprovedT3(context);
  const saved = await factory.createAgent({ ...sampleAgentInput(), exits: reviewExits });
  assert(saved.ok);
  const { id } = saved.value;
  await factory.close();

  // Act
  const recovered = await readAgentAfterRestart(harness, id);

  // Assert
  expect(recovered.ok).toBe(true);
  expect(recovered.value.name).toBe("Coder");
  expect(recovered.value.execution).toStrictEqual(saved.value.execution);
  expect(recovered.value.exits).toStrictEqual(reviewExits);
});

it("renaming an Agent exit appends a revision that keeps the exit's identity", async (context) => {
  // Arrange
  const { factory } = await openFactoryWithApprovedT3(context);
  const saved = await factory.createAgent({ ...sampleAgentInput(), exits: reviewExits });
  assert(saved.ok);
  const renamed = [reviewExits[0], { ...reviewExits[1], name: "changes" }];

  // Act
  const updated = await factory.updateAgent(saved.value.id, {
    ...sampleAgentInput(),
    exits: renamed,
    expectedRevision: saved.value.revision,
  });

  // Assert
  assert(updated.ok);
  expect(await factory.getAgent(saved.value.id)).toMatchObject({
    ok: true,
    value: { revision: 2, exits: renamed },
  });
});

it("an Agent with two exits of the same name is rejected without creating a definition", async (context) => {
  // Arrange
  const { factory } = await openFactoryWithApprovedT3(context);

  // Act
  const result = await factory.createAgent({
    ...sampleAgentInput(),
    exits: [reviewExits[0], { ...reviewExits[1], name: " pass " }],
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]?.path).toBe("exits.1.name");
  expect(await factory.listAgents()).toStrictEqual({ ok: true, value: [] });
});

it("duplicateAgent copies execution settings under a new identity", async (context) => {
  // Arrange
  const { factory } = await openFactoryWithApprovedT3(context);
  const saved = await factory.createAgent(sampleAgentInput());
  assert(saved.ok);

  // Act
  const duplicate = await factory.duplicateAgent(saved.value.id, { name: "Coder variant" });

  // Assert
  assert(duplicate.ok);
  expect(duplicate.value.id).not.toBe(saved.value.id);
  expect(duplicate.value.execution).toStrictEqual(saved.value.execution);
});

it("a stale Agent save conflicts and the accepted save survives restart", async (context) => {
  // Arrange
  const { harness, factory } = await openFactoryWithApprovedT3(context);
  const saved = await factory.createAgent(sampleAgentInput());
  assert(saved.ok);
  const updated = await factory.updateAgent(saved.value.id, {
    ...sampleAgentInput("Coder updated"),
    expectedRevision: saved.value.revision,
  });
  assert(updated.ok);

  // Act
  const conflict = await factory.updateAgent(saved.value.id, {
    ...sampleAgentInput("Lost edit"),
    expectedRevision: saved.value.revision,
  });

  // Assert
  assert(!conflict.ok);
  expect(conflict.error.code).toBe("conflict");
  await factory.close();
  const recovered = await readAgentAfterRestart(harness, saved.value.id);
  expect(recovered.value).toMatchObject({
    name: "Coder updated",
    revision: 2,
    createdAt: saved.value.createdAt,
    updatedAt: updated.value.updatedAt,
  });
});

it("listAgents preserves saved execution when capabilities are unavailable", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);
  const saved = await factory.createAgent(sampleAgentInput());
  assert(saved.ok);
  t3.capabilitiesAvailable = false;

  // Act
  const listed = await factory.listAgents();

  // Assert
  assert(listed.ok);
  const original = listed.value.find((agent) => agent.id === saved.value.id);
  expect(original?.execution.modelId).toBe("gpt-6.1-sol");
  expect(original?.settingsStatus.model.state).toBe("unknown");
});

it("Agent input missing required fields is rejected without creating a definition", async (context) => {
  // Arrange
  const { factory } = await openFactoryWithApprovedT3(context);

  // Act
  const result = await factory.createAgent({ name: "x" });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(await factory.listAgents()).toStrictEqual({ ok: true, value: [] });
});

it("a whitespace-only Agent name is rejected without creating a definition", async (context) => {
  // Arrange
  const { factory } = await openFactoryWithApprovedT3(context);

  // Act
  const result = await factory.createAgent({ ...sampleAgentInput(), name: "   " });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(await factory.listAgents()).toStrictEqual({ ok: true, value: [] });
});

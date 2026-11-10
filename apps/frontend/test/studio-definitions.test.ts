import { expect, it, vi } from "vite-plus/test";
import { held, settled } from "./support/flow-draft.ts";
import { savedAgent } from "./support/agent-draft.ts";
import {
  openedStudio,
  savedFlow,
  studioFactory,
  studioSession,
} from "./support/studio-definitions.ts";

it("a list has no value and is not synchronized until its first read answers", async () => {
  // Arrange
  const factory = studioFactory();
  held(factory.listAgents);

  // Act
  const { definitions } = studioSession(factory);
  await settled();

  // Assert
  expect(definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Review")], synchronized: true, error: null },
    agents: { value: null, synchronized: false, error: null },
  });
});

it("an accepted write leaves both lists unsynchronized with their last values until they are read again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  held(factory.listFlows);
  held(factory.listAgents);

  // Act
  await definitions.createFlow({ name: "Release" });

  // Assert
  expect(definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Review")], synchronized: false, error: null },
    agents: { value: [savedAgent()], synchronized: false, error: null },
  });
  expect(factory.listFlows).toHaveBeenCalledTimes(2);
  expect(factory.listAgents).toHaveBeenCalledTimes(2);
});

it("an answer to an older read that arrives after a newer read was requested is ignored", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const older = held(factory.listFlows);
  definitions.refresh();
  const newer = held(factory.listFlows);
  definitions.refresh();
  newer.answer([savedFlow("Newer")]);
  await settled();

  // Act
  older.answer([savedFlow("Older")]);
  await settled();

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Newer")],
    synchronized: true,
    error: null,
  });
});

it("a read requested before an accepted write cannot synchronize a list after the write", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const beforeWrite = held(factory.listAgents);
  definitions.refresh();
  held(factory.listAgents);
  await definitions.duplicateAgent("agent");

  // Act
  beforeWrite.answer([savedAgent()]);
  await settled();

  // Assert
  expect(definitions.getSnapshot().agents).toStrictEqual({
    value: [savedAgent()],
    synchronized: false,
    error: null,
  });
});

it("a failed re-read keeps the last value, unsynchronized, with its error", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const unavailable = new Error("Factory is unavailable.");
  factory.listFlows.mockRejectedValueOnce(unavailable);

  // Act
  definitions.refresh();
  await settled();

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Review")],
    synchronized: false,
    error: unavailable,
  });
});

it("a retry after a failed re-read synchronizes the list again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  factory.listFlows.mockRejectedValueOnce(new Error("Factory is unavailable."));
  definitions.refresh();
  await settled();
  factory.listFlows.mockResolvedValueOnce([savedFlow("Recovered")]);

  // Act
  definitions.refresh();
  await settled();

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Recovered")],
    synchronized: true,
    error: null,
  });
});

it("a rejected write passes its rejection to the caller and reads neither list again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const refused = new Error("Agent is still used by a Flow.");
  factory.deleteAgent.mockRejectedValueOnce(refused);

  // Act
  const deleting = definitions.deleteAgent("agent");

  // Assert
  await expect(deleting).rejects.toBe(refused);
  expect(factory.listFlows).toHaveBeenCalledTimes(1);
  expect(factory.listAgents).toHaveBeenCalledTimes(1);
  expect(definitions.getSnapshot().agents.synchronized).toBe(true);
});

it("an accepted write whose refresh fails still succeeds, and the list keeps its value with the error", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const unavailable = new Error("Factory is unavailable.");
  factory.listFlows.mockRejectedValueOnce(unavailable);

  // Act
  const removed = definitions.removeFlow("flow");
  await settled();

  // Assert
  await expect(removed).resolves.toBeUndefined();
  expect(factory.removeFlow).toHaveBeenCalledWith("flow");
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Review")],
    synchronized: false,
    error: unavailable,
  });
});

it("a read answering after its Studio session ends publishes nothing", async () => {
  // Arrange
  const factory = studioFactory();
  const opening = held(factory.listFlows);
  const { definitions } = studioSession(factory);
  const notify = vi.fn();
  definitions.subscribe(notify);
  definitions.dispose();

  // Act
  opening.answer([savedFlow("Late")]);
  await settled();

  // Assert
  expect(notify).not.toHaveBeenCalled();
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: null,
    synchronized: false,
    error: null,
  });
});

it("a write accepted after its Studio session ends returns its answer and reads neither list again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const saving = held(factory.updateAgent);
  const saved = definitions.updateAgent("agent", { ...savedAgent(), expectedRevision: 3 });
  definitions.dispose();

  // Act
  saving.answer(savedAgent({ revision: 4 }));

  // Assert
  await expect(saved).resolves.toStrictEqual(savedAgent({ revision: 4 }));
  expect(factory.listFlows).toHaveBeenCalledTimes(1);
  expect(factory.listAgents).toHaveBeenCalledTimes(1);
});

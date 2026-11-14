import { held } from "./support/flow-draft.ts";
import { expect, it, vi } from "vite-plus/test";
import { ApiError } from "../src/api.ts";
import {
  agentDraft,
  capabilities,
  savedAgent,
  editedAgent,
  failedDelete,
} from "./support/agent-draft.ts";

it("a new Agent starts with one optional-message exit and the first reporting provider's first model and defaults", () => {
  // Arrange

  // Act
  const { draft } = agentDraft(null);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: {
      name: "",
      prompt: "",
      execution: {
        environmentId: "local",
        providerInstanceId: "primary",
        modelId: "first",
        modelOptions: [
          { id: "effort", value: "low" },
          { id: "old", value: true },
        ],
      },
      exits: [{ id: expect.any(String), name: "done", description: "", messageRequired: false }],
    },
    dirty: false,
  });
});

it("a new Agent leaves the provider unset when none supports Factory reporting", () => {
  // Arrange
  const offered = { ...capabilities, providers: [capabilities.providers[0]!] };

  // Act
  const { draft } = agentDraft(null, offered);

  // Assert
  expect(draft.getSnapshot().content.execution).toStrictEqual({
    environmentId: "local",
    providerInstanceId: "",
    modelId: "",
    modelOptions: [],
  });
});

it("a new Agent leaves worker settings unset without T3 capabilities", () => {
  // Arrange

  // Act
  const { draft } = agentDraft(null, null);

  // Assert
  expect(draft.getSnapshot().content.execution).toStrictEqual({
    environmentId: "",
    providerInstanceId: "",
    modelId: "",
    modelOptions: [],
  });
});

it("saved worker settings that T3 no longer offers are kept without substitution", () => {
  // Arrange
  const agent = savedAgent({
    execution: {
      environmentId: "gone",
      providerInstanceId: "gone-provider",
      modelId: "gone-model",
      modelOptions: [{ id: "gone-option", value: "original" }],
    },
  });

  // Act
  const { draft } = agentDraft(agent);

  // Assert
  expect(draft.getSnapshot().content.execution).toStrictEqual(agent.execution);
  expect(draft.getSnapshot()).toMatchObject({
    dirty: false,
    choices: { providers: [], selectedProvider: undefined, selectedModel: undefined },
  });
});

it("choosing a provider selects its first model, preserves shared options and defaults the rest", () => {
  // Arrange
  const { draft } = agentDraft(
    savedAgent({
      execution: {
        environmentId: "local",
        providerInstanceId: "primary",
        modelId: "first",
        modelOptions: [
          { id: "effort", value: "high" },
          { id: "old", value: true },
        ],
      },
    }),
  );

  // Act
  draft.chooseProvider("other");

  // Assert
  expect(draft.getSnapshot().content.execution).toStrictEqual({
    environmentId: "local",
    providerInstanceId: "other",
    modelId: "other-first",
    modelOptions: [
      { id: "effort", value: "high" },
      { id: "new", value: false },
    ],
  });
  expect(draft.getSnapshot().dirty).toBe(true);
});

it("choosing a model preserves shared options and defaults the rest", () => {
  // Arrange
  const { draft } = agentDraft(
    savedAgent({
      execution: {
        environmentId: "local",
        providerInstanceId: "primary",
        modelId: "first",
        modelOptions: [
          { id: "effort", value: "high" },
          { id: "old", value: true },
        ],
      },
    }),
  );

  // Act
  draft.chooseModel("second");

  // Assert
  expect(draft.getSnapshot().content.execution).toStrictEqual({
    environmentId: "local",
    providerInstanceId: "primary",
    modelId: "second",
    modelOptions: [
      { id: "effort", value: "high" },
      { id: "new", value: false },
    ],
  });
});

it("editing the Agent's name leaves unsaved changes", () => {
  // Arrange
  const { draft } = agentDraft();

  // Act
  draft.edit({ name: "Changed" });

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ content: { name: "Changed" }, dirty: true });
});

it("editing the Agent's prompt leaves unsaved changes", () => {
  // Arrange
  const { draft } = agentDraft();

  // Act
  draft.edit({ prompt: "New instructions" });

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { prompt: "New instructions" },
    dirty: true,
  });
});

it("editing the Agent's exits leaves unsaved changes", () => {
  // Arrange
  const { draft } = agentDraft();

  // Act
  draft.edit({
    exits: [{ id: "done", name: "reviewed", description: "Ready", messageRequired: true }],
  });

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: {
      exits: [{ id: "done", name: "reviewed", description: "Ready", messageRequired: true }],
    },
    dirty: true,
  });
});

it("editing worker settings leaves unsaved changes", () => {
  // Arrange
  const { draft } = agentDraft();

  // Act
  draft.setEnvironmentId("another-machine");

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { execution: { environmentId: "another-machine" } },
    dirty: true,
    choices: { providers: [] },
  });
});

it("restoring the saved field values clears unsaved changes", () => {
  // Arrange
  const agent = savedAgent();
  const { draft } = agentDraft(agent);
  draft.edit({ name: "Changed", prompt: "New instructions", exits: [] });
  draft.setEnvironmentId("another-machine");

  // Act
  draft.edit({
    name: agent.name,
    prompt: agent.prompt,
    exits: agent.exits,
    execution: agent.execution,
  });

  // Assert
  expect(draft.getSnapshot().dirty).toBe(false);
});

it("an invalid Agent is rejected with the validation message without sending a request", async () => {
  // Arrange
  const { draft, factory } = agentDraft(null);

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    error: "Enter an Agent name between 1 and 200 characters.",
    saving: false,
  });
  expect(factory.createAgent).not.toHaveBeenCalled();
  expect(factory.updateAgent).not.toHaveBeenCalled();
});

it("an accepted save sends the expected revision and adopts the saved Agent as a clean baseline", async () => {
  // Arrange
  const { draft, factory } = editedAgent();

  // Act
  const saved = await draft.save();

  // Assert
  expect(factory.updateAgent).toHaveBeenCalledWith(
    "agent",
    expect.objectContaining({
      name: "Edited",
      expectedRevision: 3,
    }),
  );
  expect(saved).toStrictEqual(factory.latest());
  expect(draft.getSnapshot()).toMatchObject({
    saved: { name: "Edited", revision: 4 },
    content: { name: "Edited" },
    dirty: false,
    saving: false,
    error: "",
  });
});

it("an accepted create adopts the new Agent identity and revision", async () => {
  // Arrange
  const { draft, factory } = agentDraft(null);
  draft.edit({ name: "New reviewer", prompt: "Review the change." });

  // Act
  const saved = await draft.save();

  // Assert
  expect(factory.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ name: "New reviewer" }),
  );
  expect(factory.updateAgent).not.toHaveBeenCalled();
  expect(saved).toMatchObject({ id: "agent", revision: 1 });
  expect(draft.getSnapshot()).toMatchObject({ saved, dirty: false });
});

it("a stale save keeps edits unsaved and shows a notice identified by Factory's conflict code", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  factory.updateAgent.mockRejectedValueOnce(
    new ApiError({
      code: "conflict",
      message: "Saved elsewhere.",
      issues: [],
    }),
  );

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Edited" },
    dirty: true,
    error: "Saved elsewhere.",
    conflict: "Saved elsewhere.",
    saving: false,
  });
});

it("a failure mentioning a newer revision without a conflict code does not raise a stale-save notice", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  factory.updateAgent.mockRejectedValueOnce(new Error("Could not read a newer revision."));

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    dirty: true,
    error: "Could not read a newer revision.",
    conflict: "",
  });
});

it("an accepted delete leaves no unsaved changes", async () => {
  // Arrange
  const { draft, factory } = editedAgent();

  // Act
  const deleted = await draft.delete();

  // Assert
  expect(deleted).toBe(true);
  expect(factory.removeAgent).toHaveBeenCalledWith("agent");
  expect(draft.getSnapshot()).toMatchObject({ dirty: false, deleting: false, deleteError: "" });
});

it("a rejected delete keeps the draft unsaved and its failure separate from the save error", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  factory.updateAgent.mockRejectedValueOnce(new Error("Save unavailable."));
  await draft.save();
  factory.removeAgent.mockRejectedValueOnce(new Error("Agent is still used by a Flow."));

  // Act
  const deleted = await draft.delete();

  // Assert
  expect(deleted).toBe(false);
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Edited" },
    dirty: true,
    deleting: false,
    error: "Save unavailable.",
    deleteError: "Agent is still used by a Flow.",
  });
});

it("opening Delete again clears only its previous failure", async () => {
  // Arrange
  const { draft } = await failedDelete();

  // Act
  draft.clearDeleteError();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    deleteError: "",
    error: "Save unavailable.",
    dirty: true,
  });
});

it("an edit notifies the unsaved-change guard synchronously", () => {
  // Arrange
  const { draft } = agentDraft();
  const guard = vi.fn(() => draft.getSnapshot().dirty);
  draft.subscribe(guard);

  // Act
  draft.edit({ name: "Edited" });

  // Assert
  expect(guard).toHaveLastReturnedWith(true);
});

it("a save completing after disposal cannot notify the former guard", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  const response = held(factory.updateAgent);
  const guard = vi.fn();
  const unsubscribe = draft.subscribe(guard);
  const saving = draft.save();
  unsubscribe();
  guard.mockClear();

  // Act
  response.answer(savedAgent({ revision: 4, name: "Edited" }));
  await saving;

  // Assert
  expect(guard).not.toHaveBeenCalled();
  expect(draft.getSnapshot()).toMatchObject({ dirty: false, saved: { revision: 4 } });
});

it("a newer revision Studio read elsewhere replaces a clean Agent draft", () => {
  // Arrange
  const { draft } = agentDraft();

  // Act
  draft.reportSaved(savedAgent({ revision: 4, name: "Theirs" }));

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 4 },
    content: { name: "Theirs" },
    dirty: false,
    conflict: "",
  });
});

it("a newer revision Studio read elsewhere keeps unsaved Agent edits with a conflict notice", () => {
  // Arrange
  const { draft } = editedAgent();

  // Act
  draft.reportSaved(savedAgent({ revision: 4, name: "Theirs" }));

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Edited" },
    dirty: true,
    conflict: expect.stringContaining("saved elsewhere as revision 4"),
  });
});

import { held, settled } from "./support/flow-draft.ts";
import { expect, it, vi } from "vite-plus/test";
import { ApiError } from "../src/api.ts";
import { OfflineError } from "../src/transport.ts";
import { capabilities, savedAgent } from "./support/agent-draft.ts";
import {
  agentDraft,
  comparedAgent,
  createdAgent,
  deliver,
  echoed,
  editedAgent,
  failedDelete,
  pendingSave,
  removedElsewhere,
  savedElsewhere,
} from "./support/agent-editor.ts";

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
  expect(saved).toMatchObject({ id: "created", revision: 1 });
  expect(draft.getSnapshot()).toMatchObject({ saved, dirty: false });
});

it("a stale save keeps edits unsaved and blocks saving until the newer revision is resolved", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  factory.saveElsewhere({ name: "Saved elsewhere" });

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Edited" },
    dirty: true,
    error: "Saved elsewhere.",
    stale: true,
    canSave: false,
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
    stale: false,
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

it("a clean editor adopts a revision saved elsewhere and says which revision it was updated to", () => {
  // Arrange
  const setup = agentDraft();

  // Act
  savedElsewhere(setup, { name: "Saved elsewhere" });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 4, name: "Saved elsewhere" },
    content: { name: "Saved elsewhere" },
    dirty: false,
    updatedTo: 4,
    newer: null,
  });
});

it("a dirty editor keeps its draft and baseline and names the revision saved elsewhere", () => {
  // Arrange
  const setup = editedAgent();

  // Act
  savedElsewhere(setup, { name: "Saved elsewhere" });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Edited" },
    dirty: true,
    newer: { revision: 4, name: "Saved elsewhere" },
    updatedTo: null,
    canSave: false,
  });
});

it("a newer revision saved elsewhere replaces the revision a dirty editor names", () => {
  // Arrange
  const setup = editedAgent();
  savedElsewhere(setup, { name: "Revision 4" });

  // Act
  savedElsewhere(setup, { name: "Revision 5" });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    newer: { revision: 5, name: "Revision 5" },
  });
});

it("a delivery of the saved revision with new settings status keeps the draft and names no revision", () => {
  // Arrange
  const setup = editedAgent();
  const unavailable = savedAgent({
    settingsStatus: { ...savedAgent().settingsStatus, provider: { state: "unavailable" } },
  });

  // Act
  deliver(setup, [unavailable]);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: unavailable,
    content: { name: "Edited" },
    dirty: true,
    newer: null,
    updatedTo: null,
  });
});

it("a stale save is compared with the newer revision once Studio delivers it", async () => {
  // Arrange
  const setup = editedAgent();
  setup.factory.saveElsewhere({ name: "Saved elsewhere" });
  await setup.draft.save();
  setup.draft.compare();

  // Act
  echoed(setup);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    content: { name: "Edited" },
    stale: true,
    comparing: true,
    newer: { revision: 4, name: "Saved elsewhere" },
    error: "Saved elsewhere.",
  });
});

it("a stale save on an older server reads Studio's lists again to find the newer revision", async () => {
  // Arrange
  const setup = editedAgent("refreshed");
  await settled();
  setup.factory.saveElsewhere({ name: "Saved elsewhere" });

  // Act
  await setup.draft.save();

  // Assert
  await settled();
  expect(setup.draft.getSnapshot()).toMatchObject({
    content: { name: "Edited" },
    stale: true,
    newer: { revision: 4, name: "Saved elsewhere" },
  });
});

it("loading the latest revision after confirmation leaves a clean draft of that revision", () => {
  // Arrange
  const { draft } = comparedAgent();
  draft.requestLoadLatest(4);

  // Act
  draft.loadLatest(4);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 4, name: "Saved elsewhere" },
    content: { name: "Saved elsewhere" },
    dirty: false,
    newer: null,
    comparing: false,
    confirmingLoad: null,
    canSave: true,
  });
});

it("loading the latest revision without confirmation keeps the draft", () => {
  // Arrange
  const { draft } = comparedAgent();

  // Act
  draft.loadLatest(4);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Edited" },
    newer: { revision: 4 },
  });
});

it("keeping the edits against the newer revision rebinds the baseline, stays dirty and sends no save", () => {
  // Arrange
  const { draft, factory } = comparedAgent();

  // Act
  draft.keepEdits(4);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 4, name: "Saved elsewhere" },
    content: { name: "Edited" },
    dirty: true,
    newer: null,
    comparing: false,
    canSave: true,
  });
  expect(factory.updateAgent).not.toHaveBeenCalled();
});

it("a stale save kept against the newer revision saves against that revision", async () => {
  // Arrange
  const setup = editedAgent();
  setup.factory.saveElsewhere({ name: "Saved elsewhere" });
  await setup.draft.save();
  echoed(setup);
  setup.draft.keepEdits(4);

  // Act
  await setup.draft.save();

  // Assert
  expect(setup.factory.updateAgent).toHaveBeenLastCalledWith(
    "agent",
    expect.objectContaining({ name: "Edited", expectedRevision: 4 }),
  );
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 5, name: "Edited" },
    dirty: false,
    stale: false,
    error: "",
  });
});

it("a revision arriving during the Load latest confirmation closes it and moves the comparison to that revision", () => {
  // Arrange
  const setup = comparedAgent();
  setup.draft.requestLoadLatest(4);

  // Act
  savedElsewhere(setup, { name: "Revision 5" });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    comparing: true,
    confirmingLoad: null,
    newer: { revision: 5, name: "Revision 5" },
    content: { name: "Edited" },
  });
});

it("confirming Load latest for a revision that is no longer the newest changes nothing", () => {
  // Arrange
  const setup = comparedAgent();
  setup.draft.requestLoadLatest(4);
  savedElsewhere(setup, { name: "Revision 5" });

  // Act
  setup.draft.loadLatest(4);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Edited" },
    newer: { revision: 5 },
  });
});

it("keeping the edits against a revision that is no longer the newest changes nothing", () => {
  // Arrange
  const setup = comparedAgent();
  savedElsewhere(setup, { name: "Revision 5" });

  // Act
  setup.draft.keepEdits(4);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    newer: { revision: 5 },
    comparing: true,
  });
});

it("a removal elsewhere dismisses the comparison and its confirmation and keeps the draft", () => {
  // Arrange
  const setup = comparedAgent();
  setup.draft.requestLoadLatest(4);

  // Act
  removedElsewhere(setup);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    removed: true,
    newer: null,
    stale: false,
    comparing: false,
    confirmingLoad: null,
    content: { name: "Edited" },
    dirty: true,
  });
});

it("an own save delivered before its reply is acknowledged without a saved-elsewhere notice", async () => {
  // Arrange
  const setup = editedAgent();
  const { reply, saving } = pendingSave(setup);
  const own = savedAgent({ name: "Edited", revision: 4 });
  deliver(setup, [own]);

  // Act
  reply.answer(own);
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 4, name: "Edited" },
    dirty: false,
    newer: null,
    updatedTo: null,
    saveOutcome: "succeeded",
  });
});

it("an own save delivered after its reply is acknowledged without a saved-elsewhere notice", async () => {
  // Arrange
  const setup = editedAgent();
  await setup.draft.save();

  // Act
  echoed(setup);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: setup.factory.latest(),
    dirty: false,
    newer: null,
    updatedTo: null,
  });
});

it("a revision saved elsewhere while a save is pending is not announced before the reply", () => {
  // Arrange
  const setup = editedAgent();
  pendingSave(setup);

  // Act
  deliver(setup, [savedAgent({ name: "Saved elsewhere", revision: 4 })]);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saving: true,
    saved: { revision: 3 },
    content: { name: "Edited" },
    newer: null,
    updatedTo: null,
  });
});

it("a higher revision saved elsewhere during a save is adopted after the save's reply", async () => {
  // Arrange
  const setup = editedAgent();
  const { reply, saving } = pendingSave(setup);
  deliver(setup, [savedAgent({ name: "Saved elsewhere", revision: 5 })]);

  // Act
  reply.answer(savedAgent({ name: "Edited", revision: 4 }));
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 5, name: "Saved elsewhere" },
    content: { name: "Saved elsewhere" },
    dirty: false,
    updatedTo: 5,
  });
});

it("a removal elsewhere before a late save success keeps the Agent removed", async () => {
  // Arrange
  const setup = editedAgent();
  const { reply, saving } = pendingSave(setup);
  removedElsewhere(setup);

  // Act
  reply.answer(savedAgent({ name: "Edited", revision: 4 }));
  const saved = await saving;

  // Assert
  expect(saved).toBeUndefined();
  expect(setup.draft.getSnapshot()).toMatchObject({
    removed: true,
    saved: { revision: 3 },
    content: { name: "Edited" },
    saving: false,
  });
});

it("a rejected save shows a newer revision's notice beside the error and keeps the baseline", async () => {
  // Arrange
  const setup = editedAgent();
  const { reply, saving } = pendingSave(setup);
  deliver(setup, [savedAgent({ name: "Saved elsewhere", revision: 4 })]);

  // Act
  reply.fail(new ApiError({ code: "validation", message: "Prompt is too long.", issues: [] }));
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Edited" },
    dirty: true,
    error: "Prompt is too long.",
    saveOutcome: "rejected",
    newer: { revision: 4, name: "Saved elsewhere" },
    saving: false,
  });
});

it("a save the offline window did not send keeps the draft and says nothing was sent", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  factory.updateAgent.mockRejectedValueOnce(new OfflineError("not-sent"));

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Edited" },
    dirty: true,
    saving: false,
    saveOutcome: "not-sent",
    error: "Factory is offline. Nothing was sent; reconnect and check the current state first.",
  });
  expect(factory.updateAgent).toHaveBeenCalledTimes(1);
});

it("a save whose reply is lost reports an unknown outcome, keeps the draft and is not retried", async () => {
  // Arrange
  const { draft, factory } = editedAgent();
  factory.updateAgent.mockRejectedValueOnce(new OfflineError("unknown"));

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Edited" },
    dirty: true,
    saving: false,
    saveOutcome: "unknown",
    error: expect.stringMatching(/^Save outcome unknown\./),
  });
  expect(factory.updateAgent).toHaveBeenCalledTimes(1);
});

it("a delivered revision holding an unknown save's content is recognised as that save", async () => {
  // Arrange
  const setup = editedAgent();
  setup.factory.updateAgent.mockRejectedValueOnce(new OfflineError("unknown"));
  await setup.draft.save();

  // Act
  deliver(setup, [savedAgent({ name: "Edited", revision: 4 })]);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 4, name: "Edited" },
    dirty: false,
    newer: null,
    saveOutcome: "succeeded",
    error: "",
  });
});

it("the new-Agent form is unaffected by Agents saved or removed elsewhere", () => {
  // Arrange
  const setup = agentDraft(null);
  setup.draft.edit({ name: "Unfinished" });

  // Act
  deliver(setup, [savedAgent({ id: "other", revision: 2 })], ["agent"]);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: null,
    content: { name: "Unfinished" },
    dirty: true,
    newer: null,
    removed: false,
    canSave: true,
  });
});

it("a created Agent that Studio has not delivered yet is not treated as removed", async () => {
  // Arrange
  const setup = await createdAgent();

  // Act
  deliver(setup, [savedAgent({ id: "other" })]);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { id: "created", revision: 1 },
    removed: false,
  });
});

it("a created Agent follows a revision saved elsewhere once Studio holds it", async () => {
  // Arrange
  const setup = await createdAgent();
  echoed(setup);

  // Act
  savedElsewhere(setup, { name: "Renamed elsewhere" });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { id: "created", revision: 2, name: "Renamed elsewhere" },
    dirty: false,
    updatedTo: 2,
  });
});

it("a Create whose reply is lost blocks another Create until the Agent list has been checked", async () => {
  // Arrange
  const { draft, factory } = agentDraft(null);
  draft.edit({ name: "New reviewer", prompt: "Review the change." });
  factory.createAgent.mockRejectedValueOnce(new OfflineError("unknown"));

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: null,
    content: { name: "New reviewer" },
    saveOutcome: "unknown",
    canSave: false,
    error: expect.stringContaining("check the Agent list before creating it again"),
  });
});

it("confirming the Agent list was checked after a lost Create allows Create again", async () => {
  // Arrange
  const { draft, factory } = agentDraft(null);
  draft.edit({ name: "New reviewer", prompt: "Review the change." });
  factory.createAgent.mockRejectedValueOnce(new OfflineError("unknown"));
  await draft.save();

  // Act
  draft.allowCreateAgain();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ canSave: true, error: "", saveOutcome: null });
});

it("an own delete delivered before its reply is not a removal elsewhere", async () => {
  // Arrange
  const setup = agentDraft();
  const reply = held(setup.factory.removeAgent);
  const deleting = setup.draft.delete();
  removedElsewhere(setup);

  // Act
  reply.answer(undefined);
  await deleting;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    removed: false,
    dirty: false,
    deleting: false,
  });
});

it("a clean Agent removed elsewhere retains a draft and refuses Save", async () => {
  // Arrange
  const setup = agentDraft();
  removedElsewhere(setup);

  // Act
  const result = await setup.draft.save();

  // Assert
  expect(result).toBeUndefined();
  expect(setup.factory.updateAgent).not.toHaveBeenCalled();
  expect(setup.draft.getSnapshot()).toMatchObject({ removed: true, dirty: false, canSave: false });
});

it("an Agent removed elsewhere refuses another Delete", async () => {
  // Arrange
  const setup = agentDraft();
  removedElsewhere(setup);

  // Act
  const deleted = await setup.draft.delete();

  // Assert
  expect(deleted).toBe(false);
  expect(setup.factory.removeAgent).not.toHaveBeenCalled();
});

it("an Agent removed elsewhere refuses Duplicate", async () => {
  // Arrange
  const setup = agentDraft();
  removedElsewhere(setup);

  // Act
  const copy = await setup.draft.duplicate();

  // Assert
  expect(copy).toBeUndefined();
  expect(setup.factory.duplicateAgent).not.toHaveBeenCalled();
});

it("Copy as JSON recovers unfinished edits in the create shape after removal", () => {
  // Arrange
  const setup = agentDraft();
  removedElsewhere(setup);
  setup.draft.edit({ name: "", prompt: "Unfinished recovery" });

  // Act
  const recovered = JSON.parse(setup.draft.exportJson());

  // Assert
  expect(recovered).toEqual({
    name: "",
    prompt: "Unfinished recovery",
    execution: {
      environmentId: "local",
      providerInstanceId: "primary",
      modelId: "first",
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "old", value: true },
      ],
    },
    exits: [{ id: "done", name: "done", description: "", messageRequired: false }],
  });
});

import { expect, it } from "vite-plus/test";
import { OfflineError } from "../src/transport.ts";
import {
  agentsAfter,
  comparedFlow,
  conflictedFlow,
  deliver,
  editedFlow,
  flowDraft,
  held,
  notReady,
  openedFlow,
  rejection,
  savedElsewhere,
} from "./support/flow-draft.ts";

it("a save sends the edited Flow against the saved revision and adopts the accepted revision", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Edited");

  // Act
  await draft.save();

  // Assert
  expect(factory.updateFlow).toHaveBeenCalledWith(
    "flow",
    expect.objectContaining({ name: "Edited", expectedRevision: 1 }),
  );
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2, name: "Edited" },
    content: { name: "Edited" },
    dirty: false,
  });
});

it("a rejected save keeps the edits unsaved and shows Factory's message and issues", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Edited");
  const issue = { code: "required", path: "name", message: "Name is required." };
  factory.updateFlow.mockRejectedValueOnce(rejection({ issues: [issue] }));

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Edited" },
    dirty: true,
    busy: false,
    error: "Flow is invalid.",
    issues: [issue],
    conflict: { status: "none" },
  });
});

it("no save is sent while a revision conflict is unresolved", async () => {
  // Arrange
  const { draft, factory } = await conflictedFlow();

  // Act
  await draft.save();

  // Assert
  expect(factory.updateFlow).toHaveBeenCalledTimes(1);
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    dirty: true,
    conflict: { status: "detected" },
  });
});

it("a second save is not sent while the first is in flight", async () => {
  // Arrange
  const { draft, factory } = await editedFlow();
  held(factory.updateFlow);
  void draft.save();

  // Act
  await draft.save();

  // Assert
  expect(factory.updateFlow).toHaveBeenCalledTimes(1);
  expect(draft.getSnapshot().busy).toBe(true);
});

it("an edit made while a readiness check is in flight is not applied", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Checked");
  held(factory.validateFlow);
  void draft.check();

  // Act
  draft.edit({ name: "Later" });

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ content: { name: "Checked" }, busy: true });
});

it("taking the latest saved Flow discards local edits and leaves a clean draft at its revision", async () => {
  // Arrange
  const { draft } = await comparedFlow();

  // Act
  draft.takeLatest(2);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Theirs" },
    dirty: false,
    error: "",
    conflict: { status: "none" },
    canSave: true,
  });
});

it("after keeping the local draft, another client's save makes the next save conflict again", async () => {
  // Arrange
  const { draft, factory } = await comparedFlow();
  draft.keepLocal(2);
  factory.saveElsewhere("Theirs again");

  // Act
  await draft.save();

  // Assert
  expect(factory.updateFlow).toHaveBeenLastCalledWith(
    "flow",
    expect.objectContaining({ name: "Mine", expectedRevision: 2 }),
  );
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    dirty: true,
    conflict: { status: "detected" },
  });
});

it("a failed comparison keeps the conflict and reports the failure", async () => {
  // Arrange
  const { draft, factory } = await conflictedFlow();
  factory.getFlow.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  // Act
  await draft.compareLatest();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    dirty: true,
    error: "Could not load the latest revision. Try again.",
    conflict: { status: "detected" },
  });
});

it("a comparison moves to a newer revision, and taking the revision it showed before does nothing", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  savedElsewhere(setup, "Second");
  await setup.draft.compareLatest();
  savedElsewhere(setup, "Third");

  // Act
  const taken = setup.draft.takeLatest(2);

  // Assert
  expect(taken).toBe(false);
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    conflict: { status: "compared", latest: { revision: 3, name: "Third" } },
  });
});

it("a newer revision delivered by Studio's source replaces a clean draft", async () => {
  // Arrange
  const setup = await openedFlow();

  // Act
  savedElsewhere(setup, "Theirs");

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 2, name: "Theirs" },
    content: { name: "Theirs" },
    dirty: false,
    updatedTo: 2,
    conflict: { status: "none" },
  });
});

it("a newer revision delivered by Studio's source keeps unsaved edits and names that revision", async () => {
  // Arrange
  const setup = await editedFlow("Mine");

  // Act
  savedElsewhere(setup, "Theirs");

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    dirty: true,
    conflict: { status: "detected", revision: 2 },
    canSave: false,
  });
});

it("a newer revision delivered during an interaction is adopted when it ends with the draft still clean", async () => {
  // Arrange
  const setup = await openedFlow();
  setup.draft.beginInteraction();
  savedElsewhere(setup, "Theirs");

  // Act
  setup.draft.endInteraction();

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Theirs" },
    dirty: false,
  });
});

it("an edit made during an interaction keeps the draft and names the newer revision when it ends", async () => {
  // Arrange
  const setup = await openedFlow();
  setup.draft.beginInteraction();
  savedElsewhere(setup, "Theirs");
  setup.draft.edit({ name: "Mine" });

  // Act
  setup.draft.endInteraction();

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    conflict: { status: "detected", revision: 2 },
  });
});

it("a clean Flow shows the readiness Studio's source delivers with its Agents at the same revision", async () => {
  // Arrange
  const setup = await openedFlow();

  // Act
  deliver(setup, { ...setup.factory.latest(), readiness: notReady });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Review" },
    readiness: notReady,
    canStartRun: false,
  });
});

it("changed saved Agents make a checked unsaved draft's readiness unknown and ask for another check", async () => {
  // Arrange
  const { draft } = await editedFlow();
  await draft.check();

  // Act
  draft.observeAgents(agentsAfter);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ readiness: null, agentsChanged: true });
});

it("a readiness check answering after the saved Agents changed is not shown", async () => {
  // Arrange
  const { draft, factory } = await editedFlow();
  const check = held(factory.validateFlow);
  const checking = draft.check();
  draft.observeAgents(agentsAfter);

  // Act
  check.answer({ ready: true, issues: [] });
  await checking;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ readiness: null, agentsChanged: true });
});

it("an unsynchronized source makes readiness unknown and Start Run unavailable", async () => {
  // Arrange
  const setup = await openedFlow();

  // Act
  setup.draft.observe({ definition: setup.factory.latest(), synchronized: false });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({ readiness: null, canStartRun: false });
});

it("a fresh link to an absent Flow is not found rather than removed", () => {
  // Arrange
  const setup = flowDraft();

  // Act
  deliver(setup, null);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    presence: "missing",
    saved: null,
    retained: null,
    canSave: false,
  });
});

it("a Flow removed elsewhere keeps its draft editable, disables its actions and is retained for discard", async () => {
  // Arrange
  const setup = await openedFlow();

  // Act
  deliver(setup, null);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    presence: "removed",
    content: { name: "Review" },
    dirty: false,
    retained: "removed",
    canSave: false,
    canStartRun: false,
    canRemove: false,
  });
});

it("a removed Flow's draft is copied in the shape Flow creation accepts", async () => {
  // Arrange
  const setup = await openedFlow();
  deliver(setup, null);
  setup.draft.edit({ name: "Recovered" });

  // Act
  const input = setup.draft.createInput();

  // Assert
  expect(input).toStrictEqual({
    name: "Recovered",
    graph: setup.factory.latest().graph,
    workspace: setup.factory.latest().workspace,
  });
});

it("this editor's save delivered before its reply raises no saved-elsewhere notice", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  const reply = held(setup.factory.updateFlow);
  const saving = setup.draft.save();
  const mine = { ...setup.factory.latest(), name: "Mine", revision: 2 };
  deliver(setup, mine);

  // Act
  reply.answer(mine);
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    dirty: false,
    updatedTo: null,
    conflict: { status: "none" },
  });
});

it("a revision saved elsewhere while this editor's save is pending is adopted after its reply", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  const reply = held(setup.factory.updateFlow);
  const saving = setup.draft.save();
  deliver(setup, { ...setup.factory.latest(), name: "Theirs", revision: 3 });

  // Act
  reply.answer({ ...setup.factory.latest(), name: "Mine", revision: 2 });
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 3, name: "Theirs" },
    content: { name: "Theirs" },
    dirty: false,
    updatedTo: 3,
  });
});

it("a removal elsewhere beats this editor's late save success", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  const reply = held(setup.factory.updateFlow);
  const saving = setup.draft.save();
  deliver(setup, null);

  // Act
  reply.answer({ ...setup.factory.latest(), name: "Mine", revision: 2 });
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    presence: "removed",
    content: { name: "Mine" },
    retained: "removed",
    canSave: false,
  });
});

it("a save whose reply is lost reports an unknown outcome, keeps the draft and sends nothing more", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Mine");
  factory.updateFlow.mockRejectedValueOnce(new OfflineError());

  // Act
  await draft.save();

  // Assert
  expect(factory.updateFlow).toHaveBeenCalledTimes(1);
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    dirty: true,
    busy: false,
    saveOutcomeUnknown: true,
    error: "",
  });
});

it("an accepted Flow removal clears unsaved changes before its caller navigates", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Mine");
  const reported: { dirty: boolean; removing: boolean }[] = [];
  const unsubscribe = draft.subscribe(() => {
    const { dirty, removing } = draft.getSnapshot();
    reported.push({ dirty, removing });
  });

  // Act
  const removed = await draft.remove();

  // Assert
  expect(removed).toBe(true);
  expect(draft.getSnapshot()).toMatchObject({ dirty: false, removing: false, removalError: "" });
  expect(factory.removeFlow).toHaveBeenCalledWith("flow");
  expect(reported).toStrictEqual([
    { dirty: true, removing: true },
    { dirty: false, removing: false },
  ]);
  unsubscribe();
});

it("this editor's removal delivered before its reply leaves no retained draft to discard", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  const reply = held(setup.factory.removeFlow);
  const removing = setup.draft.remove();
  deliver(setup, null);

  // Act
  reply.answer(undefined);
  await removing;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({ presence: "removed", retained: null });
});

it("a failed Flow removal keeps the local draft unsaved and reports a separate removal error", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Mine");
  factory.updateFlow.mockRejectedValueOnce(rejection({ message: "Save refused." }));
  await draft.save();
  const content = draft.getSnapshot().content;
  factory.removeFlow.mockRejectedValueOnce(rejection({ message: "Removal refused." }));

  // Act
  const removed = await draft.remove();

  // Assert
  expect(removed).toBe(false);
  expect(draft.getSnapshot().content).toBe(content);
  expect(draft.getSnapshot()).toMatchObject({
    dirty: true,
    removing: false,
    error: "Save refused.",
    removalError: "Removal refused.",
  });
});

it("a save reaching a removed Flow keeps the local draft and reports the rejection", async () => {
  // Arrange
  const { draft, factory } = await editedFlow("Mine");
  await factory.removeFlow("flow");
  const content = draft.getSnapshot().content;

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot().content).toBe(content);
  expect(draft.getSnapshot()).toMatchObject({
    dirty: true,
    error: "Flow was removed.",
    removalError: "",
    conflict: { status: "none" },
  });
});

it("changed saved Agents keep an unresolved revision conflict and its refused save", async () => {
  // Arrange
  const { draft } = await conflictedFlow();

  // Act
  draft.observeAgents(agentsAfter);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ conflict: { status: "detected" }, canSave: false });
});

it("this editor's removal reply arriving before the source's removal leaves no retained draft", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  await setup.draft.remove();

  // Act
  deliver(setup, null);

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({ presence: "removed", retained: null });
});

it("a late save reply keeps the readiness Studio's source delivered for the same revision", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  const reply = held(setup.factory.updateFlow);
  const saving = setup.draft.save();
  const saved = { ...setup.factory.latest(), name: "Mine", revision: 2 };
  deliver(setup, { ...saved, readiness: notReady });

  // Act
  reply.answer({ ...saved, readiness: { ready: true, issues: [] } });
  await saving;

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    readiness: notReady,
    canStartRun: false,
  });
});

it("this editor's pending save shows no saved-elsewhere notice when its own revision arrives first", async () => {
  // Arrange
  const setup = await editedFlow("Mine");
  held(setup.factory.updateFlow);
  void setup.draft.save();

  // Act
  deliver(setup, { ...setup.factory.latest(), name: "Mine", revision: 2 });

  // Assert
  expect(setup.draft.getSnapshot()).toMatchObject({ busy: true, conflict: { status: "none" } });
});

it("a clean Flow shows no readiness from its save reply until Studio's source delivers that revision", async () => {
  // Arrange
  const { draft } = await editedFlow("Mine");

  // Act
  await draft.save();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    dirty: false,
    readiness: null,
    canStartRun: false,
  });
});

it("a check the server ran against newer saved Agents than those shown is not shown", async () => {
  // Arrange
  const { draft, factory } = await editedFlow();
  factory.validateFlow.mockResolvedValueOnce({
    ready: true,
    issues: [],
    agentGeneration: agentsAfter,
  });

  // Act
  await draft.check();

  // Assert
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("a check against newer saved Agents is shown once Studio's source shows those Agents", async () => {
  // Arrange
  const { draft, factory } = await editedFlow();
  factory.validateFlow.mockResolvedValueOnce({
    ready: true,
    issues: [],
    agentGeneration: agentsAfter,
  });
  await draft.check();

  // Act
  draft.observeAgents(agentsAfter);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    readiness: { ready: true, issues: [] },
    agentsChanged: false,
  });
});

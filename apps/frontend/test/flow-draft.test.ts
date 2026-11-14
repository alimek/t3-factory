import { expect, it } from "vite-plus/test";
import { OfflineError } from "../src/transport.ts";
import {
  editedFlow,
  held,
  hiddenFlow,
  interactingFlow,
  lostReply,
  createdFlow,
  missingFlow,
  olderServerRefusedFlow,
  settled,
  notReady,
  openedFlow,
  comparedFlow,
  refusedFlow,
  rejection,
  savingFlow,
} from "./support/flow-draft.ts";

it("a save sends the edited Flow against the saved revision and adopts the accepted revision", async () => {
  // Arrange
  const { draft, factory } = editedFlow("Edited");

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
  const { draft, factory } = editedFlow("Edited");
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

it("no save is sent while a refused save's revision conflict is unresolved", async () => {
  // Arrange
  const { draft, factory } = await refusedFlow();

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
  const { draft, factory } = editedFlow();
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
  const { draft, factory } = editedFlow("Checked");
  held(factory.validateFlow);
  void draft.check();

  // Act
  draft.edit({ name: "Later" });

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ content: { name: "Checked" }, busy: true });
});

it("a clean Flow adopts a revision saved elsewhere and says it was updated", () => {
  // Arrange
  const { draft, factory, published } = openedFlow();
  factory.saveElsewhere("Theirs", notReady);

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Theirs" },
    dirty: false,
    updatedTo: 2,
    readiness: notReady,
    conflict: { status: "none" },
  });
});

it("an accepted Flow removal clears unsaved changes before its caller navigates", async () => {
  // Arrange
  const { draft, factory } = editedFlow("Mine");
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

it("a failed Flow removal keeps the local draft unsaved and reports a separate removal error", async () => {
  // Arrange
  const { draft, factory } = editedFlow("Mine");
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
  const { draft, factory } = editedFlow("Mine");
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

it("a readiness check failing after the editor was hidden reports nothing", async () => {
  // Arrange
  const { draft, factory } = openedFlow();
  const check = held(factory.validateFlow);
  const checking = draft.check();
  draft.hide();

  // Act
  check.fail(rejection({ message: "Validation failed." }));
  await checking;

  // Assert
  expect(draft.getSnapshot().error).toBe("");
});

it("a changed saved Agent keeps an unresolved revision conflict and its refused save", async () => {
  // Arrange
  const { draft, agentChanged } = await refusedFlow();

  // Act
  agentChanged();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ conflict: { status: "detected" }, canSave: false });
});

it("an unsaved draft keeps its edits and baseline and names the revision saved elsewhere", () => {
  // Arrange
  const { draft, factory, published } = editedFlow("Mine");
  factory.saveElsewhere("Theirs");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    dirty: true,
    updatedTo: null,
    conflict: { status: "detected", revision: 2 },
    canSave: false,
  });
});

it("a comparison moves to the next revision saved elsewhere when it arrives", () => {
  // Arrange
  const { draft, factory, published } = comparedFlow();
  factory.saveElsewhere("Theirs again");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    conflict: { status: "compared", latest: { revision: 3, name: "Theirs again" } },
  });
});

it("taking a compared revision that is no longer the latest leaves the draft unchanged", () => {
  // Arrange
  const { draft, factory, published } = comparedFlow();
  factory.saveElsewhere("Theirs again");
  published();

  // Act
  draft.takeLatest(2);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    dirty: true,
    conflict: { status: "compared", latest: { revision: 3 } },
  });
});

it("keeping the local draft against a revision that is no longer the latest keeps its baseline", () => {
  // Arrange
  const { draft, factory, published } = comparedFlow();
  factory.saveElsewhere("Theirs again");
  published();

  // Act
  draft.keepLocal(2);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    conflict: { status: "compared", latest: { revision: 3 } },
  });
});

it("taking the latest compared revision discards local edits and leaves a clean draft at it", () => {
  // Arrange
  const { draft } = comparedFlow();

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

it("keeping the local draft against the compared revision rebinds it and sends no save", () => {
  // Arrange
  const { draft, factory } = comparedFlow();

  // Act
  draft.keepLocal(2);

  // Assert
  expect(factory.updateFlow).not.toHaveBeenCalled();
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Mine" },
    dirty: true,
    conflict: { status: "none" },
    canSave: true,
  });
});

it("a clean Flow waits for a drag, wire, Auto-arrange or typing to finish before adopting a revision", () => {
  // Arrange
  const { draft, factory, published } = interactingFlow();
  factory.saveElsewhere("Theirs");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Review" },
    updatedTo: null,
    conflict: { status: "none" },
  });
});

it("a revision that arrived during an interaction is adopted when it ends with the draft clean", () => {
  // Arrange
  const { draft, factory, published, end } = interactingFlow();
  factory.saveElsewhere("Theirs");
  published();

  // Act
  end();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Theirs" },
    dirty: false,
    updatedTo: 2,
  });
});

it("an interaction that changed the draft keeps the change and names the revision that arrived meanwhile", () => {
  // Arrange
  const { draft, factory, published, end } = interactingFlow();
  factory.saveElsewhere("Theirs");
  published();
  draft.edit({ name: "Dropped here" });

  // Act
  end();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Dropped here" },
    dirty: true,
    conflict: { status: "detected", revision: 2 },
  });
});

it("a revision saved elsewhere makes readiness unknown at once, even while adoption waits", () => {
  // Arrange
  const { draft, factory, published } = interactingFlow();
  factory.saveElsewhere("Theirs");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ readiness: null, canStartRun: false });
});

it("a revision saved elsewhere clears an unsaved draft's readiness check", async () => {
  // Arrange
  const { draft, factory, published } = editedFlow();
  await draft.check();
  factory.saveElsewhere("Theirs");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("losing synchronization makes a clean Flow's readiness unknown and disables Start Run", () => {
  // Arrange
  const { draft, disconnected } = openedFlow();

  // Act
  disconnected();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ readiness: null, canStartRun: false });
});

it("a removal elsewhere clears readiness and dismisses the comparison but keeps the draft", async () => {
  // Arrange
  const { draft, removedElsewhere } = comparedFlow();
  await draft.check();

  // Act
  await removedElsewhere();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    removed: true,
    content: { name: "Mine" },
    dirty: true,
    readiness: null,
    conflict: { status: "none" },
  });
});

it("a pending save's own revision arriving live first raises no saved-elsewhere notice", () => {
  // Arrange
  const { draft, factory, published } = savingFlow();
  factory.commit("Mine");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    busy: true,
    saveState: "pending",
    conflict: { status: "none" },
  });
});

it("a save answered after its own revision arrived live leaves a clean draft at that revision", async () => {
  // Arrange
  const { draft, factory, published, reply, saving } = savingFlow();
  const accepted = factory.commit("Mine");
  published();

  // Act
  reply.answer(accepted);
  await saving;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Mine" },
    dirty: false,
    updatedTo: null,
    saveState: "succeeded",
    conflict: { status: "none" },
  });
});

it("a save's own revision arriving live after its answer is not announced as an update", async () => {
  // Arrange
  const { draft, factory, published, reply, saving } = savingFlow();
  reply.answer(factory.commit("Mine"));
  await saving;

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    dirty: false,
    updatedTo: null,
    conflict: { status: "none" },
  });
});

it("a revision saved elsewhere after a pending save is adopted once the save's answer arrives", async () => {
  // Arrange
  const { draft, factory, published, reply, saving } = savingFlow();
  const accepted = factory.commit("Mine");
  factory.saveElsewhere("Theirs");
  published();

  // Act
  reply.answer(accepted);
  await saving;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 3 },
    content: { name: "Theirs" },
    dirty: false,
    updatedTo: 3,
  });
});

it("a removal elsewhere beats a later successful answer to a pending save", async () => {
  // Arrange
  const { draft, factory, removedElsewhere, reply, saving } = savingFlow();
  const accepted = factory.commit("Mine");
  await removedElsewhere();

  // Act
  reply.answer(accepted);
  await saving;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    removed: true,
    saved: { revision: 1 },
    content: { name: "Mine" },
    dirty: true,
  });
});

it("a save whose answer is lost reports an unknown outcome, keeps the draft and is not sent again", async () => {
  // Arrange
  const { draft, factory, reply, saving } = savingFlow();

  // Act
  reply.fail(lostReply());
  await saving;

  // Assert
  expect(factory.updateFlow).toHaveBeenCalledTimes(1);
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    dirty: true,
    busy: false,
    saveState: "unknown",
    error: expect.stringContaining("Save outcome unknown"),
  });
});

it("a save with an unknown outcome is recognised when its revision arrives live", async () => {
  // Arrange
  const { draft, factory, published, reply, saving } = savingFlow();
  factory.commit("Mine");
  reply.fail(lostReply());
  await saving;

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    dirty: false,
    saveState: "succeeded",
    error: "",
    conflict: { status: "none" },
  });
});

it("a save that was not sent because Factory is offline is not reported as an unknown outcome", async () => {
  // Arrange
  const { draft, reply, saving } = savingFlow();

  // Act
  reply.fail(new OfflineError("not-sent"));
  await saving;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    dirty: true,
    busy: false,
    saveState: "rejected",
    error: new OfflineError("not-sent").message,
  });
});

it("a rejected save shows a revision saved elsewhere meanwhile beside its error without rebinding", async () => {
  // Arrange
  const { draft, factory, published, reply, saving } = savingFlow();
  factory.saveElsewhere("Theirs");
  published();

  // Act
  reply.fail(rejection({ message: "Name is invalid." }));
  await saving;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Mine" },
    error: "Name is invalid.",
    saveState: "rejected",
    conflict: { status: "detected", revision: 2 },
  });
});

it("a save answered after the server's protocol changed has an unknown outcome", async () => {
  // Arrange
  const { draft, factory, reply, saving } = savingFlow();
  draft.reportProtocol(11);

  // Act
  reply.answer(factory.commit("Mine"));
  await saving;

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    dirty: true,
    saveState: "unknown",
  });
});

it("a clean Flow hidden while Agents are shown adopts a revision saved elsewhere", () => {
  // Arrange
  const { draft, factory, published } = hiddenFlow();
  factory.saveElsewhere("Theirs");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 2 },
    content: { name: "Theirs" },
    updatedTo: 2,
  });
});

it("an Agent change that only changes the saved Flow's readiness keeps the draft clean and unannounced", () => {
  // Arrange
  const { draft, factory, published } = openedFlow();

  // Act
  published({ ...factory.latest(), readiness: notReady });

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Review" },
    dirty: false,
    updatedTo: null,
    readiness: notReady,
    canStartRun: false,
  });
});

it("a changed saved Agent clears an unsaved draft's readiness check", async () => {
  // Arrange
  const { draft, agentChanged } = editedFlow();
  await draft.check();

  // Act
  agentChanged();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ content: { name: "Edited" }, readiness: null });
});

it("a readiness check answered after a saved Agent changed is dropped", async () => {
  // Arrange
  const { draft, factory, agentChanged } = editedFlow();
  const answer = held(factory.validateFlow);
  const checking = draft.check();
  agentChanged();

  // Act
  answer.answer({ ready: true, issues: [] });
  await checking;

  // Assert
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("a readiness check answered after the editor was hidden is dropped", async () => {
  // Arrange
  const { draft, factory } = editedFlow();
  const answer = held(factory.validateFlow);
  const checking = draft.check();
  draft.hide();

  // Act
  answer.answer({ ready: true, issues: [] });
  await checking;

  // Assert
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("a Flow missing from Studio's first current saved Flows is not found", () => {
  // Arrange
  const { draft } = missingFlow();

  // Act
  const opened = draft.getSnapshot();

  // Assert
  expect(opened).toMatchObject({
    status: "failed",
    saved: null,
    removed: false,
    error: "Flow not found.",
    canSave: false,
  });
});

it("a created Flow opens from its create answer before Studio receives it live", () => {
  // Arrange
  const { draft } = createdFlow();

  // Act
  const opened = draft.getSnapshot();

  // Assert
  expect(opened).toMatchObject({
    status: "loaded",
    saved: { revision: 1 },
    removed: false,
    error: "",
  });
});

it("on an older server, comparing reads the saved Flows again and shows the newer revision", async () => {
  // Arrange
  const { draft } = await olderServerRefusedFlow();

  // Act
  draft.compareLatest();
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    conflict: { status: "compared", latest: { revision: 2, name: "Theirs" } },
  });
});

it("on an older server, a failed comparison read keeps the conflict and reports the failure", async () => {
  // Arrange
  const { draft, listFlows } = await olderServerRefusedFlow();
  listFlows.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  // Act
  draft.compareLatest();
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    dirty: true,
    error: "Could not load the latest revision. Try again.",
    conflict: { status: "detected", revision: null },
  });
});

it("an unsaved draft names a revision saved elsewhere at once, even during an interaction", () => {
  // Arrange
  const { draft, factory, published } = interactingFlow();
  draft.edit({ name: "Mine" });
  factory.saveElsewhere("Theirs");

  // Act
  published();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    content: { name: "Mine" },
    conflict: { status: "detected", revision: 2 },
  });
});

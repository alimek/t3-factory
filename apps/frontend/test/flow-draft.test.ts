import { expect, it } from "vite-plus/test";
import {
  comparedFlow,
  conflictedFlow,
  editedFlow,
  flowDraft,
  held,
  hiddenFlow,
  memoryFactory,
  notReady,
  openedFlow,
  rejection,
  settled,
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
  draft.takeLatest();

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
  draft.keepLocal();
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

it("a clean Flow shown again takes Factory's current readiness but not another client's revision", async () => {
  // Arrange
  const { draft, factory } = await hiddenFlow();
  factory.saveElsewhere("Theirs", notReady);

  // Act
  draft.reportVisibility(true);
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    saved: { revision: 1 },
    content: { name: "Review" },
    dirty: false,
    readiness: notReady,
  });
});

it("refreshed saved Agents re-read readiness for a visible clean Flow", async () => {
  // Arrange
  const { draft, factory } = await openedFlow();
  factory.saveElsewhere("Theirs", notReady);

  // Act
  draft.reportAgentsRefreshed();
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ content: { name: "Review" }, readiness: notReady });
});

it("refreshed saved Agents start no read for a hidden Flow", async () => {
  // Arrange
  const { draft, factory } = await hiddenFlow();
  const reads = factory.getFlow.mock.calls.length;

  // Act
  draft.reportAgentsRefreshed();
  await settled();

  // Assert
  expect(factory.getFlow).toHaveBeenCalledTimes(reads);
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("refreshed saved Agents make an unsaved draft's readiness unknown without reading saved readiness", async () => {
  // Arrange
  const { draft, factory } = await editedFlow();
  const reads = factory.getFlow.mock.calls.length;

  // Act
  draft.reportAgentsRefreshed();
  await settled();

  // Assert
  expect(factory.getFlow).toHaveBeenCalledTimes(reads);
  expect(draft.getSnapshot()).toMatchObject({ content: { name: "Edited" }, readiness: null });
});

it("a failed readiness refresh leaves readiness unknown and reports the error", async () => {
  // Arrange
  const { draft, factory } = await openedFlow();
  factory.getFlow.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  // Act
  draft.reportAgentsRefreshed();
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    readiness: null,
    error: "Failed to fetch",
    canStartRun: false,
  });
});

it("a readiness answer requested before an edit is dropped", async () => {
  // Arrange
  const { draft, factory } = await openedFlow();
  const refresh = held(factory.getFlow);
  draft.reportAgentsRefreshed();
  draft.edit({ name: "Edited" });

  // Act
  refresh.answer(factory.latest());
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ dirty: true, readiness: null });
});

it("a readiness answer requested before a save is dropped", async () => {
  // Arrange
  const { draft, factory } = await openedFlow();
  const refresh = held(factory.getFlow);
  draft.reportAgentsRefreshed();
  factory.updateFlow.mockRejectedValueOnce(rejection());
  await draft.save();

  // Act
  refresh.answer(factory.latest());
  await settled();

  // Assert
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("a readiness answer requested before the editor was hidden is dropped", async () => {
  // Arrange
  const { draft, factory } = await openedFlow();
  const refresh = held(factory.getFlow);
  draft.reportAgentsRefreshed();
  draft.reportVisibility(false);

  // Act
  refresh.answer(factory.latest());
  await settled();

  // Assert
  expect(draft.getSnapshot().readiness).toBeNull();
});

it("a readiness answer arriving after a newer request's answer is dropped", async () => {
  // Arrange
  const { draft, factory } = await openedFlow();
  const older = held(factory.getFlow);
  draft.reportAgentsRefreshed();
  factory.saveElsewhere("Theirs", notReady);
  draft.reportAgentsRefreshed();
  await settled();

  // Act
  older.answer({ ...factory.latest(), readiness: { ready: true, issues: [] } });
  await settled();

  // Assert
  expect(draft.getSnapshot().readiness).toStrictEqual(notReady);
});

it("a failed load reports the failure and offers no editable draft", async () => {
  // Arrange
  const factory = memoryFactory();
  factory.getFlow.mockRejectedValueOnce(
    rejection({ code: "not_found", message: "Flow not found." }),
  );

  // Act
  const { draft } = flowDraft(factory);
  await settled();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    status: "failed",
    saved: null,
    error: "Flow not found.",
    canSave: false,
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

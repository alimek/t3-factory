import { assert, expect, it, vi } from "vite-plus/test";
import { ApiError } from "../src/api.ts";
import { byCreation, draftTitle } from "../src/run-draft.ts";
import { composer, pendingStart, reopen, unknownStart } from "./support/run-draft.ts";

it("an unknown Start keeps submitted fields read-only", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context);
  const before = draft.getSnapshot();

  // Act
  draft.edit({ input: "Replacement", projectId: "other-project", flowId: "other-flow" });

  // Assert
  expect(draft.getSnapshot()).toStrictEqual(before);
  expect(draft.getSnapshot()).toMatchObject({ input: "Do the work", pending: true, busy: false });
  expect(startRun).toHaveBeenCalledTimes(1);
});

it("New Run keeps an unresolved submission with its draft for the same check", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context);
  const submitted = structuredClone(startRun.mock.calls[0]?.[0]);
  const { draftId } = draft.getSnapshot();
  assert(draftId);
  draft.openFresh();
  draft.openDraft(draftId);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  const runId = await draft.start();

  // Assert
  expect(startRun.mock.calls[1]?.[0]).toStrictEqual(submitted);
  expect(runId).toBe("accepted-run");
});

it("New Run opens an empty prompt with remembered choices and keeps the previous draft", (context) => {
  // Arrange
  const { draft } = composer(context);

  // Act
  draft.openFresh();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ input: "", projectId: "project", flowId: "flow" });
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Do the work"]);
});

it("Start Run from a Flow opens that Flow in a fresh composition", (context) => {
  // Arrange
  const { draft } = composer(context);

  // Act
  draft.openFlow("other-flow");

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ input: "", flowId: "other-flow", pending: false });
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Do the work"]);
});

it("Check same request sends the identical key and payload after a lost response", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context);
  const submitted = structuredClone(startRun.mock.calls[0]?.[0]);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  const runId = await draft.start();

  // Assert
  expect(startRun).toHaveBeenCalledTimes(2);
  expect(startRun.mock.calls[1]?.[0]).toStrictEqual(submitted);
  expect(submitted).toStrictEqual({
    requestId: expect.any(String),
    projectId: "project",
    flowId: "flow",
    input: "Do the work",
    title: "Do the work",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  expect(runId).toBe("accepted-run");
  expect(draft.getSnapshot()).toMatchObject({ input: "", pending: false, busy: false });
});

it("a reopened client checks the same request after a lost response", async (context) => {
  // Arrange
  const lost = await unknownStart(context);
  const submitted = structuredClone(lost.startRun.mock.calls[0]?.[0]);
  const { draft, startRun } = reopen(lost);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });
  draft.edit({ input: "Replacement" });

  // Act
  const runId = await draft.start();

  // Assert
  expect(startRun.mock.calls[1]?.[0]).toStrictEqual(submitted);
  expect(runId).toBe("accepted-run");
});

it("reloading during an in-flight Start reopens it as the same pending request", (context) => {
  // Arrange
  const sending = pendingStart(context);

  // Act
  const { draft } = reopen(sending);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    input: "Do the work",
    pending: true,
    busy: false,
  });
});

it("another server never sees this server's drafts or pending Start", async (context) => {
  // Arrange
  const lost = await unknownStart(context);
  lost.draft.leave();

  // Act
  const { draft } = reopen(lost, "server-b");

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ input: "", pending: false });
  expect(draft.getDrafts()).toStrictEqual([]);
});

it("another server's fresh composer does not preselect this server's Project and Flow", (context) => {
  // Arrange
  const chosen = composer(context);

  // Act
  const { draft } = reopen(chosen, "server-b");

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ projectId: "", flowId: "" });
});

it("a whitespace-only prompt removes its draft and keeps the selections", (context) => {
  // Arrange
  const { draft } = composer(context);
  draft.edit({ input: " \n\t " });

  // Act
  draft.leave();

  // Assert
  expect(draft.getDrafts()).toStrictEqual([]);
  expect(draft.getSnapshot()).toMatchObject({ projectId: "project", flowId: "flow" });
});

it("a new draft joins Run navigation only after the user leaves the New Run view", (context) => {
  // Arrange
  const { draft } = composer(context);
  draft.edit({ input: "Still typing" });
  const whileComposing = draft.getDrafts();

  // Act
  draft.leave();

  // Assert
  expect(whileComposing).toStrictEqual([]);
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Still typing"]);
});

it("drafts are listed newest first and editing one does not move it", (context) => {
  // Arrange
  const { draft } = composer(context);
  const first = draft.getSnapshot().draftId;
  assert(first);
  vi.setSystemTime(new Date("2026-11-07T08:05:00Z"));
  draft.openFresh();
  draft.edit({ input: "Second" });
  draft.openDraft(first);

  // Act
  draft.edit({ input: "First, edited later" });

  // Assert
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Second", "First, edited later"]);
});

it("a renamed draft keeps its trimmed title through prompt edits and reload", (context) => {
  // Arrange
  const typed = composer(context);
  const { draftId } = typed.draft.getSnapshot();
  assert(draftId);
  typed.draft.leave();
  typed.draft.rename(draftId, "  Release notes  ");
  typed.draft.edit({ input: "A different first line" });

  // Act
  const { draft } = reopen(typed);

  // Assert
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Release notes"]);
});

it("a blank rename keeps the draft and its automatic title after reload", (context) => {
  // Arrange
  const typed = composer(context);
  const { draftId } = typed.draft.getSnapshot();
  assert(draftId);
  typed.draft.leave();
  typed.draft.rename(draftId, " \t ");

  // Act
  const { draft } = reopen(typed);

  // Assert
  expect(draft.getDrafts().map(draftTitle)).toStrictEqual(["Do the work"]);
});

it("clearing the prompt removes a renamed draft", (context) => {
  // Arrange
  const { draft } = composer(context);
  const { draftId } = draft.getSnapshot();
  assert(draftId);
  draft.leave();
  draft.rename(draftId, "Release notes");

  // Act
  draft.edit({ input: "  " });

  // Assert
  expect(draft.getDrafts()).toStrictEqual([]);
});

it("discarding a draft removes it after reload and keeps the other drafts", (context) => {
  // Arrange
  const typed = composer(context);
  const { draftId } = typed.draft.getSnapshot();
  assert(draftId);
  typed.draft.openFresh();
  typed.draft.edit({ input: "Keep this one" });
  typed.draft.leave();

  // Act
  typed.draft.discard(draftId);

  // Assert
  expect(reopen(typed).draft.getDrafts().map(draftTitle)).toStrictEqual(["Keep this one"]);
});

it("discarding the open draft leaves an empty composition with the same choices", (context) => {
  // Arrange
  const { draft } = composer(context);
  const { draftId } = draft.getSnapshot();
  assert(draftId);

  // Act
  draft.discard(draftId);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    draftId: undefined,
    input: "",
    projectId: "project",
    flowId: "flow",
  });
});

it("Discard keeps an unresolved Start for the same check", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context);
  const submitted = structuredClone(startRun.mock.calls[0]?.[0]);
  const { draftId } = draft.getSnapshot();
  assert(draftId);
  draft.discard(draftId);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  const runId = await draft.start();

  // Assert
  expect(startRun.mock.calls[1]?.[0]).toStrictEqual(submitted);
  expect(runId).toBe("accepted-run");
});

it("Start submits the draft's bounded first-line title and its original creation time", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  vi.setSystemTime(new Date("2026-11-07T08:05:00Z"));
  const prompt = " \n\t\r\n  " + "x".repeat(501) + "\nFull input retained";
  draft.edit({ input: prompt });
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  expect(startRun.mock.calls[0]?.[0]).toStrictEqual({
    requestId: expect.any(String),
    projectId: "project",
    flowId: "flow",
    input: prompt,
    title: "x".repeat(500),
    createdAt: "2026-11-07T08:00:00.000Z",
  });
});

it("a started draft's Run keeps the draft's place among entries created at the same time", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  const started = draft.getSnapshot().draftId;
  assert(started);
  draft.openFresh();
  draft.edit({ input: "Created at the same moment" });
  draft.leave();
  const before = draft.getDrafts();
  draft.openDraft(started);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  const request = startRun.mock.calls[0]?.[0];
  assert(request);
  const run = { id: "accepted-run", createdAt: request.createdAt, creationKey: request.requestId };
  const after = [...draft.getDrafts(), run].toSorted(byCreation);
  expect(run.creationKey).toBe(started);
  expect(after.indexOf(run)).toBe(before.findIndex((entry) => entry.id === started));
});

it("Start submits a renamed draft's manual title", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  const { draftId } = draft.getSnapshot();
  assert(draftId);
  draft.rename(draftId, "Release notes");
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  expect(startRun.mock.calls[0]?.[0]).toMatchObject({ title: "Release notes" });
});

it("an accepted Start removes its draft instead of listing it beside the Run", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  draft.leave();
  startRun.mockResolvedValueOnce({ id: "accepted-run" });

  // Act
  await draft.start();

  // Assert
  expect(draft.getDrafts()).toStrictEqual([]);
});

it("a Flow confirmed deleted clears only that selection", (context) => {
  // Arrange
  const { draft } = composer(context);

  // Act
  draft.forgetUnavailable("flowId", ["another-flow"]);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    input: "Do the work",
    projectId: "project",
    flowId: "",
  });
});

it("an accepted Start is not offered for checking again after reload", async (context) => {
  // Arrange
  const accepted = composer(context);
  accepted.startRun.mockResolvedValueOnce({ id: "accepted-run" });
  await accepted.draft.start();

  // Act
  const { draft } = reopen(accepted);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ input: "", pending: false });
});

it("reopening the client restores the exact unsubmitted prompt and choices", (context) => {
  // Arrange
  const typed = composer(context);
  typed.draft.edit({ input: "  Keep this\n\n  exact spacing  " });

  // Act
  const { draft } = reopen(typed);

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    input: "  Keep this\n\n  exact spacing  ",
    projectId: "project",
    flowId: "flow",
    pending: false,
  });
});

it("an in-flight Start cannot be sent concurrently", async (context) => {
  // Arrange
  const { draft, startRun } = pendingStart(context);
  const before = draft.getSnapshot();

  // Act
  const duplicate = await draft.start();

  // Assert
  expect(duplicate).toBeUndefined();
  expect(draft.getSnapshot()).toStrictEqual(before);
  expect(draft.getSnapshot()).toMatchObject({ pending: true, busy: true, input: "Do the work" });
  expect(startRun).toHaveBeenCalledTimes(1);
});

it("blocked local storage cannot turn a confirmed Start into an unknown result", async (context) => {
  // Arrange
  const { draft, startRun, storage } = composer(context);
  startRun.mockResolvedValueOnce({ id: "accepted-run" });
  storage.setItem.mockImplementation(() => {
    throw new Error("Storage blocked");
  });

  // Act
  const runId = await draft.start();

  // Assert
  expect(runId).toBe("accepted-run");
  expect(draft.getSnapshot()).toMatchObject({ input: "", pending: false, busy: false, error: "" });
});

it("an unknown Start warns when blocked storage cannot keep it for recovery", async (context) => {
  // Arrange
  const { draft, startRun, storage } = composer(context);
  startRun.mockRejectedValueOnce(new TypeError("Response lost"));
  storage.setItem.mockImplementation(() => {
    throw new Error("Storage blocked");
  });

  // Act
  await draft.start();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({ pending: true, busy: false });
  expect(draft.getSnapshot().error).toContain("could not save the request");
});

it("drafts kept only in memory after a failed save survive editing another draft", (context) => {
  // Arrange
  const { draft, storage } = composer(context);
  storage.setItem.mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  draft.openFresh();
  draft.edit({ input: "Unsaved second" });
  draft.openFresh();

  // Act
  draft.edit({ input: "Unsaved third" });

  // Assert
  expect(draft.getDrafts().map(draftTitle)).toContain("Unsaved second");
});

it("a recovered save keeps drafts another tab saved while this tab's writes failed", (context) => {
  // Arrange
  const setup = composer(context);
  const write = setup.storage.setItem.getMockImplementation();
  assert(write);
  let blocked = true;
  setup.storage.setItem.mockImplementation((key, value) => {
    if (blocked) throw new Error("Quota exceeded");
    write(key, value);
  });
  setup.draft.openFresh();
  setup.draft.edit({ input: "Unsaved here" });
  blocked = false;
  const other = reopen(setup).draft;
  other.openFresh();
  other.edit({ input: "Other tab" });
  other.leave();

  // Act
  setup.draft.leave();

  // Assert
  expect(reopen(setup).draft.getDrafts().map(draftTitle)).toEqual(
    expect.arrayContaining(["Other tab", "Unsaved here"]),
  );
});

it("opening New Run keeps a draft another tab saved before this tab synced", (context) => {
  // Arrange
  const setup = composer(context);
  setup.draft.leave();
  const other = reopen(setup).draft;
  other.openFresh();
  other.edit({ input: "Other tab" });
  other.leave();

  // Act
  setup.draft.openFresh();

  // Assert
  expect(reopen(setup).draft.getDrafts().map(draftTitle)).toContain("Other tab");
});

it("validation settles Start and keeps the prompt available for correction", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  startRun.mockRejectedValueOnce(
    new ApiError({ code: "validation", message: "Not ready", issues: [] }),
  );

  // Act
  await draft.start();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    input: "Do the work",
    pending: false,
    busy: false,
    error: "Not ready",
  });
});

it("a missing Start reference settles the request without clearing the prompt", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  startRun.mockRejectedValueOnce(
    new ApiError({
      code: "not_found",
      message: "Flow removed",
      issues: [],
    }),
  );

  // Act
  await draft.start();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    input: "Do the work",
    pending: false,
    busy: false,
    error: "Flow removed",
  });
});

import { expect, it, vi } from "vite-plus/test";
import { ApiError } from "../src/api.ts";
import { composer, pendingStart, sourceRun, unknownStart } from "./support/run-draft.ts";

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

it("New Run cannot discard an unresolved Run again submission", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context, true);
  const before = draft.getSnapshot();

  // Act
  draft.openFresh();

  // Assert
  expect(draft.getSnapshot()).toStrictEqual(before);
  expect(startRun).toHaveBeenCalledTimes(1);
});

it("Start Run from a Flow cannot replace an unresolved submission", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context);
  const before = draft.getSnapshot();

  // Act
  draft.openFlow("other-flow");

  // Assert
  expect(draft.getSnapshot()).toStrictEqual(before);
  expect(startRun).toHaveBeenCalledTimes(1);
});

it("Run again opens the pending composer without replacing its submission", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context);
  const before = draft.getSnapshot();
  const confirmReplacement = vi.fn(() => true);

  // Act
  const open = draft.openRunAgain(sourceRun, confirmReplacement);

  // Assert
  expect(open).toBe(true);
  expect(draft.getSnapshot()).toStrictEqual(before);
  expect(startRun).toHaveBeenCalledTimes(1);
  expect(confirmReplacement).not.toHaveBeenCalled();
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
  });
  expect(runId).toBe("accepted-run");
  expect(draft.getSnapshot()).toMatchObject({ input: "", pending: false, busy: false });
});

it("Run again recovery keeps its source snapshot and Task slot", async (context) => {
  // Arrange
  const { draft, startRun } = await unknownStart(context, true);
  const submitted = structuredClone(startRun.mock.calls[0]?.[0]);
  startRun.mockRejectedValueOnce(new TypeError("Still unknown"));

  // Act
  await draft.start();

  // Assert
  expect(startRun.mock.calls[1]?.[0]).toStrictEqual(submitted);
  expect(submitted).toStrictEqual({
    requestId: expect.any(String),
    projectId: sourceRun.task.projectId,
    taskId: sourceRun.task.id,
    sourceRunId: sourceRun.id,
    input: sourceRun.input,
  });
  expect(draft.getSnapshot()).toMatchObject({
    input: sourceRun.input,
    sourceRunId: sourceRun.id,
    taskId: sourceRun.task.id,
    pending: true,
    busy: false,
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
  storage.setItem.mockClear();
  storage.setItem.mockImplementation(() => {
    throw new Error("Storage blocked");
  });

  // Act
  const runId = await draft.start();

  // Assert
  expect(runId).toBe("accepted-run");
  expect(draft.getSnapshot()).toMatchObject({ input: "", pending: false, busy: false, error: "" });
  expect(storage.setItem.mock.calls).toStrictEqual([
    ["factory-last-project", "project"],
    ["factory-last-flow", "flow"],
  ]);
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

it("a Task slot conflict settles Start and exposes the existing Run", async (context) => {
  // Arrange
  const { draft, startRun } = composer(context);
  startRun.mockRejectedValueOnce(
    new ApiError({
      code: "conflict",
      message: "Task occupied",
      issues: [{ code: "active_run", path: "taskId", message: "existing-run" }],
    }),
  );

  // Act
  await draft.start();

  // Assert
  expect(draft.getSnapshot()).toMatchObject({
    input: "Do the work",
    pending: false,
    busy: false,
    activeRunId: "existing-run",
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

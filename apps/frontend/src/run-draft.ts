import { useSyncExternalStore } from "react";
import type { StartRunInput } from "@t3-factory/contracts";
import { randomId } from "./lib/ids.ts";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "./api.ts";

interface RunDraft {
  projectId: string;
  flowId: string;
  input: string;
  pending: boolean;
  busy: boolean;
  error: string;
}

const unknownOutcome =
  "Start outcome unknown. Your input and request identity are kept. Check the same request again to recover its Run without creating a duplicate.";

const unsavedUnknownOutcome =
  "Start outcome unknown, and this browser could not save the request for recovery after a reload. Keep this window open and check the same request again to recover its Run without creating a duplicate.";

const pendingStartKey = (server: string) => `factory-pending-start:${server}`;

function readPendingStart(server: string): StartRunInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(localStorage.getItem(pendingStartKey(server)) ?? "null");
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { requestId, projectId, flowId, input } = value as Record<string, unknown>;
  if (!filled(requestId) || !filled(projectId) || !filled(flowId) || !filled(input))
    return undefined;
  return Object.freeze({ requestId, projectId, flowId, input });
}

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function savePendingStart(server: string, request: StartRunInput) {
  try {
    localStorage.setItem(pendingStartKey(server), JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}

function forgetPendingStart(server: string) {
  try {
    localStorage.removeItem(pendingStartKey(server));
  } catch {
    // A request left behind is only offered again under its original key, never as new work.
  }
}

function confirmedRejection(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && ["validation", "conflict", "not_found"].includes(error.detail.code)
  );
}

export function createRunDraft(
  startRun: (submission: StartRunInput) => Promise<{ id: string }> = api.startRun,
) {
  const rememberedChoices = new Map<string, string>();
  function remembered(key: string) {
    const cached = rememberedChoices.get(key);
    if (cached !== undefined) return cached;
    try {
      return localStorage.getItem(`factory-last-${key}`) ?? "";
    } catch {
      return "";
    }
  }
  function rememberChoice(key: string, value: string) {
    rememberedChoices.set(key, value);
    try {
      localStorage.setItem(`factory-last-${key}`, value);
    } catch {
      // Preferences remain available in memory when browser storage is unavailable.
    }
  }
  let draft: Readonly<RunDraft> = {
    projectId: remembered("project"),
    flowId: remembered("flow"),
    input: "",
    pending: false,
    busy: false,
    error: "",
  };
  let server: string | undefined;
  let submission: StartRunInput | undefined;
  const listeners = new Set<() => void>();
  function selectServer(next: string) {
    if (next === server) return;
    server = next;
    const previous = submission;
    submission = readPendingStart(next);
    if (submission) {
      const { projectId, flowId, input } = submission;
      update({ projectId, flowId, input, pending: true, busy: false, error: unknownOutcome });
    } else if (previous) {
      update({ input: "", pending: false, busy: false, error: "" });
    }
  }
  function update(change: Partial<RunDraft>) {
    draft = { ...draft, ...change };
    listeners.forEach((notify) => notify());
  }
  function edit(change: Partial<Pick<RunDraft, "projectId" | "flowId" | "input">>) {
    if (submission) return;
    update({ ...change, error: "" });
    if (change.projectId !== undefined) {
      rememberChoice("project", draft.projectId);
      rememberChoice("flow", draft.flowId);
    }
  }
  function openFresh() {
    if (submission) return;
    update({ flowId: draft.flowId || remembered("flow"), error: "" });
  }
  function openFlow(flowId: string) {
    if (submission) return;
    update({ flowId });
  }
  function pendingSubmission(): StartRunInput {
    if (submission) return submission;
    return Object.freeze({
      requestId: randomId(),
      projectId: draft.projectId,
      flowId: draft.flowId,
      input: draft.input,
    });
  }
  function rejectStart(error: unknown, recoverable: boolean) {
    if (confirmedRejection(error)) {
      submission = undefined;
      update({
        pending: false,
        busy: false,
        error: [error.message, ...error.detail.issues.map((issue) => issue.message)].join(" "),
      });
    } else {
      update({ busy: false, error: recoverable ? unknownOutcome : unsavedUnknownOutcome });
    }
  }
  async function start() {
    const requestServer = server;
    if (draft.busy || !draft.input.trim() || requestServer === undefined) return;
    const request = pendingSubmission();
    submission = request;
    const recoverable = savePendingStart(requestServer, request);
    update({ pending: true, busy: true, error: "" });
    let run;
    try {
      run = await startRun(request);
    } catch (error) {
      if (confirmedRejection(error)) forgetPendingStart(requestServer);
      if (requestServer === server) rejectStart(error, recoverable);
      return;
    }
    forgetPendingStart(requestServer);
    if (requestServer !== server) return;
    // Only the transport result decides Start's outcome; preferences and navigation do not.
    rememberChoice("project", request.projectId);
    rememberChoice("flow", request.flowId);
    submission = undefined;
    update({ input: "", pending: false, busy: false });
    return run.id;
  }
  return {
    getSnapshot: () => draft,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    selectServer,
    edit,
    openFresh,
    openFlow,
    start,
  };
}

export const runDraft = createRunDraft();

export function useRunDraft() {
  return useSyncExternalStore(runDraft.subscribe, runDraft.getSnapshot);
}

export function useComposerNavigation() {
  const navigate = useNavigate();
  function openFlowComposer(flowId: string) {
    runDraft.openFlow(flowId);
    void navigate({ to: "/runs/new" });
  }
  return { openFlowComposer };
}

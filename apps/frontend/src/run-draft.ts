import { useSyncExternalStore } from "react";
import type { RunDetail, StartRunInput } from "@t3-factory/contracts";
import { randomId } from "./lib/ids.ts";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "./api.ts";

interface RunDraft {
  projectId: string;
  flowId: string;
  input: string;
  taskId?: string | undefined;
  /** Settled Run title when composing Run again. */
  sourceTitle?: string | undefined;
  /** Snapshot-based Run again; backend resolves definitions from this Run. */
  sourceRunId?: string | undefined;
  /** Flow name from the source Run snapshot (display only). */
  snapshotFlowName?: string | undefined;
  pending: boolean;
  busy: boolean;
  error: string;
  activeRunId?: string | undefined;
}

type RunAgainSource = Pick<RunDetail, "id" | "title" | "input"> & {
  task: Pick<RunDetail["task"], "id" | "projectId">;
  snapshot: { flow: Pick<RunDetail["snapshot"]["flow"], "name"> };
};

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
  let submission: StartRunInput | undefined;
  const listeners = new Set<() => void>();
  function update(change: Partial<RunDraft>) {
    draft = { ...draft, ...change };
    listeners.forEach((notify) => notify());
  }
  function currentDefinitions(flowId: string) {
    return {
      sourceRunId: undefined,
      sourceTitle: undefined,
      snapshotFlowName: undefined,
      flowId,
      taskId: undefined,
    };
  }
  function edit(change: Partial<Pick<RunDraft, "projectId" | "flowId" | "input">>) {
    if (submission) return;
    update({
      ...change,
      ...(change.projectId !== undefined && change.projectId !== draft.projectId
        ? { taskId: undefined }
        : {}),
      error: "",
      activeRunId: undefined,
    });
    if (change.projectId !== undefined) {
      rememberChoice("project", draft.projectId);
      rememberChoice("flow", draft.flowId);
    }
  }
  function openFresh() {
    if (submission) return;
    update({
      ...currentDefinitions(draft.flowId || remembered("flow")),
      error: "",
      activeRunId: undefined,
    });
  }
  function openFlow(flowId: string) {
    if (submission) return;
    update(currentDefinitions(flowId));
  }
  function openRunAgain(run: RunAgainSource, confirmReplacement: () => boolean) {
    if (submission) return true;
    if (draft.input.trim() && !confirmReplacement()) return false;
    update({
      projectId: run.task.projectId,
      flowId: "",
      input: run.input,
      taskId: run.task.id,
      sourceTitle: run.title,
      sourceRunId: run.id,
      snapshotFlowName: run.snapshot.flow.name,
      error: "",
      activeRunId: undefined,
    });
    return true;
  }
  function pendingSubmission(): StartRunInput {
    if (submission) return submission;
    const base = {
      requestId: randomId(),
      projectId: draft.projectId,
      input: draft.input,
      ...(draft.taskId ? { taskId: draft.taskId } : {}),
    };
    return Object.freeze(
      draft.sourceRunId
        ? { ...base, sourceRunId: draft.sourceRunId }
        : { ...base, flowId: draft.flowId },
    );
  }
  function rejectStart(error: unknown) {
    if (
      error instanceof ApiError &&
      ["validation", "conflict", "not_found"].includes(error.detail.code)
    ) {
      submission = undefined;
      update({
        pending: false,
        busy: false,
        error: [error.message, ...error.detail.issues.map((issue) => issue.message)].join(" "),
        activeRunId: error.detail.issues.find((issue) => issue.code === "active_run")?.message,
      });
    } else {
      update({
        busy: false,
        error:
          "Start outcome unknown. Your input and request identity are kept. Check the same request again to recover its Run without creating a duplicate.",
      });
    }
  }
  async function start() {
    if (draft.busy || !draft.input.trim()) return;
    const request = pendingSubmission();
    submission = request;
    update({ pending: true, busy: true, error: "" });
    let run;
    try {
      run = await startRun(request);
    } catch (error) {
      rejectStart(error);
      return;
    }
    // Only the transport result decides Start's outcome; preferences and navigation do not.
    rememberChoice("project", request.projectId);
    if (request.flowId) rememberChoice("flow", request.flowId);
    submission = undefined;
    update({
      input: "",
      taskId: undefined,
      sourceTitle: undefined,
      sourceRunId: undefined,
      snapshotFlowName: undefined,
      pending: false,
      busy: false,
      activeRunId: undefined,
    });
    return run.id;
  }
  return {
    getSnapshot: () => draft,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    edit,
    openFresh,
    openFlow,
    openRunAgain,
    start,
  };
}

export const runDraft = createRunDraft();

export function useRunDraft() {
  return useSyncExternalStore(runDraft.subscribe, runDraft.getSnapshot);
}

export function useComposerNavigation() {
  const navigate = useNavigate();
  const open = () => {
    void navigate({ to: "/runs/new" });
  };
  function openRunComposer(run: RunDetail) {
    if (runDraft.openRunAgain(run, () => window.confirm("Replace your current Run draft?"))) open();
  }
  function openFlowComposer(flowId: string) {
    runDraft.openFlow(flowId);
    open();
  }
  return { openRunComposer, openFlowComposer };
}

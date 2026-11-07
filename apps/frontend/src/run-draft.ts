import { useSyncExternalStore } from "react";
import type { StartRunInput } from "@t3-factory/contracts";
import { isCanonicalTimestamp, TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import { randomId } from "./lib/ids.ts";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "./api.ts";

/** Client-local Run preparation. It exists only while its prompt has a non-whitespace character. */
export interface SavedRunDraft {
  readonly id: string;
  readonly input: string;
  readonly projectId: string;
  readonly flowId: string;
  /** A title chosen by the user; absent while the title follows the prompt. */
  readonly manualTitle?: string;
  readonly createdAt: string;
  /** Run navigation shows the draft once the user has left its composition. */
  readonly listed: boolean;
  /** The frozen Start request awaiting a confirmed outcome. */
  readonly submission?: StartRunInput;
}

interface RunDraft {
  draftId: string | undefined;
  projectId: string;
  flowId: string;
  input: string;
  pending: boolean;
  busy: boolean;
  error: string;
  saveFailed: boolean;
}

type Choice = "projectId" | "flowId";

const unknownOutcome =
  "Start outcome unknown. Your input and request identity are kept. Check the same request again to recover its Run without creating a duplicate.";

const unsavedUnknownOutcome =
  "Start outcome unknown, and this browser could not save the request for recovery after a reload. Keep this window open and check the same request again to recover its Run without creating a duplicate.";

export function draftTitle(draft: Pick<SavedRunDraft, "input" | "manualTitle">) {
  const firstLine = draft.input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return draft.manualTitle ?? firstLine?.slice(0, TASK_TITLE_LIMIT) ?? "Untitled draft";
}

/**
 * Newest first, then ascending creation key: the order Run navigation uses. A draft's key is
 * its id, which its Start sends as the request key, so its Run takes the same place.
 */
export function byCreation(
  a: { createdAt: string; id: string; creationKey?: string },
  b: typeof a,
) {
  const age = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (age) return age;
  const [first, second] = [a.creationKey ?? a.id, b.creationKey ?? b.id];
  return first < second ? -1 : first > second ? 1 : 0;
}

const draftsKey = (server: string) => `factory-run-drafts:${server}`;

interface SavedDrafts {
  current: string | undefined;
  drafts: readonly SavedRunDraft[];
}

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function readSubmission(value: unknown): StartRunInput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { requestId, projectId, flowId, input, title, createdAt } = value as Record<
    string,
    unknown
  >;
  if (!filled(requestId) || !filled(projectId) || !filled(flowId) || !filled(input))
    return undefined;
  if (!filled(title) || !isCanonicalTimestamp(createdAt)) return undefined;
  return Object.freeze({ requestId, projectId, flowId, input, title, createdAt });
}

function readDraft(value: unknown): SavedRunDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, input, projectId, flowId, manualTitle, createdAt, listed, submission } =
    value as Record<string, unknown>;
  if (!filled(id) || !filled(input) || typeof projectId !== "string") return undefined;
  if (typeof flowId !== "string" || typeof listed !== "boolean") return undefined;
  if (!isCanonicalTimestamp(createdAt)) return undefined;
  if (manualTitle !== undefined && !filled(manualTitle)) return undefined;
  const request = readSubmission(submission);
  if (submission !== undefined && !request) return undefined;
  return {
    id,
    input,
    projectId,
    flowId,
    ...(manualTitle === undefined ? {} : { manualTitle }),
    createdAt,
    listed,
    ...(request ? { submission: request } : {}),
  };
}

/** Undefined when storage cannot be read; malformed saved data reads as no drafts. */
function readSaved(server: string): SavedDrafts | undefined {
  let text: string | null;
  try {
    text = localStorage.getItem(draftsKey(server));
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text ?? "null");
  } catch {
    value = null;
  }
  const { current, drafts } = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const valid = Array.isArray(drafts) ? drafts.map(readDraft).filter((d) => d !== undefined) : [];
  return {
    current: typeof current === "string" ? current : undefined,
    drafts: valid.toSorted(byCreation),
  };
}

function writeSaved(server: string, saved: SavedDrafts) {
  try {
    localStorage.setItem(draftsKey(server), JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

function withoutSubmission({ submission, ...editable }: SavedRunDraft): SavedRunDraft {
  void submission;
  return editable;
}

function confirmedRejection(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && ["validation", "conflict", "not_found"].includes(error.detail.code)
  );
}

export function createRunDraft(
  startRun: (submission: StartRunInput) => Promise<{ id: string }> = api.startRun,
) {
  let server: string | undefined;
  const rememberedChoices = new Map<string, string>();
  function remembered(key: string) {
    if (server === undefined) return "";
    const name = `factory-last-${key}:${server}`;
    const cached = rememberedChoices.get(name);
    if (cached !== undefined) return cached;
    try {
      return localStorage.getItem(name) ?? "";
    } catch {
      return "";
    }
  }
  function rememberChoice(key: string, value: string) {
    if (server === undefined) return;
    const name = `factory-last-${key}:${server}`;
    rememberedChoices.set(name, value);
    try {
      localStorage.setItem(name, value);
    } catch {
      // Preferences remain available in memory when browser storage is unavailable.
    }
  }
  let drafts: readonly SavedRunDraft[] = [];
  let listedDrafts: readonly SavedRunDraft[] = [];
  let current = { projectId: "", flowId: "", input: "" };
  let currentId: string | undefined;
  let error = "";
  let saveFailed = false;
  const unsaved = new Map<string, SavedRunDraft | undefined>();
  const inFlight = new Set<string>();
  let draft: Readonly<RunDraft> = snapshot();
  const listeners = new Set<() => void>();

  function snapshot(): RunDraft {
    const saved = drafts.find((d) => d.id === currentId);
    return {
      draftId: currentId,
      ...current,
      pending: !!saved?.submission,
      busy: !!currentId && inFlight.has(currentId),
      error,
      saveFailed,
    };
  }
  function publish() {
    draft = snapshot();
    const listed = drafts.filter((d) => d.listed);
    if (
      listed.length !== listedDrafts.length ||
      listed.some((d, index) => d !== listedDrafts[index])
    )
      listedDrafts = listed;
    listeners.forEach((notify) => notify());
  }
  /**
   * Applies one draft's change over the latest saved drafts, so other tabs' edits to other
   * drafts survive and ordinary edits to the same draft are last-save-wins.
   */
  function commit(
    scope: string,
    id: string,
    change: (saved: SavedRunDraft | undefined) => SavedRunDraft | undefined,
  ) {
    const stored = readSaved(scope)?.drafts;
    const latest = scope === server ? (stored ? withUnsaved(stored) : drafts) : (stored ?? []);
    const previous = latest.find((d) => d.id === id) ?? (scope === server ? find(id) : undefined);
    const next = change(previous);
    const others = latest.filter((d) => d.id !== id);
    const result = next ? [...others, next].toSorted(byCreation) : others;
    const saved = writeSaved(scope, {
      current: scope === server ? currentId : readSaved(scope)?.current,
      drafts: result,
    });
    if (scope === server) {
      drafts = result;
      saveFailed = !saved;
      if (saved) unsaved.clear();
      else unsaved.set(id, next);
    }
    return saved;
  }
  /** Overlays this tab's changes that failed to save onto other tabs' stored drafts. */
  function withUnsaved(stored: readonly SavedRunDraft[]) {
    if (unsaved.size === 0) return stored;
    const kept = stored.filter((d) => !unsaved.has(d.id));
    const local = [...unsaved.values()].filter((d) => d !== undefined);
    return [...kept, ...local].toSorted(byCreation);
  }
  function find(id: string | undefined) {
    return drafts.find((d) => d.id === id);
  }
  function show(saved: SavedRunDraft | undefined) {
    currentId = saved?.id;
    error = saved?.submission && !inFlight.has(saved.id) ? unknownOutcome : "";
    if (saved) {
      const { projectId, flowId, input } = saved;
      current = { projectId, flowId, input };
    }
  }
  function selectServer(next: string) {
    if (next === server) return;
    server = next;
    unsaved.clear();
    const saved = readSaved(next);
    drafts = saved?.drafts ?? [];
    const restored = find(saved?.current);
    if (restored) show(restored);
    else {
      show(undefined);
      current = { projectId: remembered("project"), flowId: remembered("flow"), input: "" };
    }
    publish();
  }
  function leaveComposition() {
    const leaving = find(currentId);
    if (server === undefined || !leaving || leaving.listed) return false;
    commit(server, leaving.id, (saved) => saved && { ...saved, listed: true });
    return true;
  }
  function save() {
    if (server === undefined) return;
    if (!current.input.trim()) {
      const removed = currentId;
      currentId = undefined;
      if (removed) commit(server, removed, () => undefined);
      return;
    }
    const id = currentId ?? randomId();
    currentId = id;
    commit(server, id, (saved) => ({
      ...(saved ?? { id, createdAt: new Date().toISOString(), listed: false }),
      ...current,
    }));
  }
  function edit(change: Partial<Pick<RunDraft, Choice | "input">>) {
    if (find(currentId)?.submission) return;
    current = { ...current, ...change };
    error = "";
    if (change.projectId !== undefined || change.flowId !== undefined) {
      rememberChoice("project", current.projectId);
      rememberChoice("flow", current.flowId);
    }
    save();
    publish();
  }
  function openComposition(next: SavedRunDraft | undefined, flowId?: string) {
    leaveComposition();
    show(next);
    if (!next)
      current = {
        projectId: remembered("project") || current.projectId,
        flowId: flowId ?? (remembered("flow") || current.flowId),
        input: "",
      };
    if (server !== undefined) writeSaved(server, { current: currentId, drafts });
    publish();
  }
  /** Clears a selected Project or Flow that a successful catalog read no longer lists. */
  function forgetUnavailable(choice: Choice, available: readonly string[]) {
    if (!current[choice] || available.includes(current[choice])) return;
    if (find(currentId)?.submission) return;
    current = { ...current, [choice]: "" };
    save();
    publish();
  }
  /** False when the title is blank or too long, or the draft awaits a Start outcome. */
  function rename(id: string, title: string) {
    const manualTitle = title.trim();
    const saved = find(id);
    if (server === undefined || !saved || saved.submission) return false;
    if (!manualTitle || manualTitle.length > TASK_TITLE_LIMIT) return false;
    commit(server, id, (latest = saved) => ({ ...latest, manualTitle }));
    publish();
    return true;
  }
  /** A draft awaiting a Start outcome is kept so its exact request can still be checked. */
  function discard(id: string) {
    const saved = find(id);
    if (server === undefined || !saved || saved.submission) return;
    if (id === currentId) {
      currentId = undefined;
      current = { ...current, input: "" };
      error = "";
    }
    commit(server, id, () => undefined);
    publish();
  }
  function rejectStart(id: string, failure: unknown, recoverable: boolean) {
    if (id !== currentId) return;
    if (confirmedRejection(failure))
      error = [failure.message, ...failure.detail.issues.map((issue) => issue.message)].join(" ");
    else error = recoverable ? unknownOutcome : unsavedUnknownOutcome;
  }
  async function start() {
    const requestServer = server;
    const saved = find(currentId);
    if (requestServer === undefined || !saved || inFlight.has(saved.id)) return;
    const { id } = saved;
    const request =
      saved.submission ??
      Object.freeze({
        // Rejected requests are never recorded, so one key per draft can still be retried.
        requestId: id,
        projectId: saved.projectId,
        flowId: saved.flowId,
        input: saved.input,
        title: draftTitle(saved),
        createdAt: saved.createdAt,
      });
    inFlight.add(id);
    const recoverable = commit(requestServer, id, (latest = saved) => ({
      ...latest,
      submission: request,
    }));
    error = "";
    publish();
    let run;
    try {
      run = await startRun(request);
    } catch (failure) {
      inFlight.delete(id);
      if (confirmedRejection(failure))
        commit(requestServer, id, (latest) => latest && withoutSubmission(latest));
      if (requestServer === server) {
        rejectStart(id, failure, recoverable);
        publish();
      }
      return;
    }
    inFlight.delete(id);
    const shown = requestServer === server && id === currentId;
    if (shown) currentId = undefined;
    commit(requestServer, id, () => undefined);
    if (!shown) {
      publish();
      return;
    }
    // Only the transport result decides Start's outcome; preferences and navigation do not.
    rememberChoice("project", request.projectId);
    rememberChoice("flow", request.flowId);
    current = { ...current, input: "" };
    publish();
    return run.id;
  }
  function syncFromStorage() {
    if (server === undefined) return;
    const saved = readSaved(server);
    if (!saved) return;
    drafts = withUnsaved(saved.drafts);
    const latest = find(currentId);
    if (latest) {
      const { projectId, flowId, input } = latest;
      current = { projectId, flowId, input };
    } else if (currentId && !inFlight.has(currentId)) {
      currentId = undefined;
      current = { ...current, input: "" };
    }
    publish();
  }
  if (typeof window !== "undefined")
    window.addEventListener("storage", (event) => {
      if (server !== undefined && event.key === draftsKey(server)) syncFromStorage();
    });
  return {
    getSnapshot: () => draft,
    /** Drafts shown in Run navigation, newest first. */
    getDrafts: () => listedDrafts,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    selectServer,
    edit,
    /** New Run: an empty prompt with remembered choices; the previous draft stays saved. */
    openFresh: () => openComposition(undefined),
    /** Start Run from a Flow: a fresh composition with that Flow. */
    openFlow: (flowId: string) => openComposition(undefined, flowId),
    openDraft(id: string) {
      const saved = find(id);
      if (saved && saved.id !== currentId) openComposition(saved);
    },
    /** The user left the New Run view, so its draft joins Run navigation. */
    leave() {
      if (leaveComposition()) publish();
    },
    forgetUnavailable,
    rename,
    discard,
    start,
  };
}

export const runDraft = createRunDraft();

export function useRunDraft() {
  return useSyncExternalStore(runDraft.subscribe, runDraft.getSnapshot);
}

export function useRunDrafts() {
  return useSyncExternalStore(runDraft.subscribe, runDraft.getDrafts);
}

export function useComposerNavigation() {
  const navigate = useNavigate();
  function openFlowComposer(flowId: string) {
    runDraft.openFlow(flowId);
    void navigate({ to: "/runs/new" });
  }
  return { openFlowComposer };
}

import { useSyncExternalStore } from "react";
import type {
  PromptSegment,
  RunImage,
  StartRunInput,
  ValidationIssue,
} from "@t3-factory/contracts";
import {
  isCanonicalTimestamp,
  isSha256Hex,
  promptText,
  RUN_IMAGE_LIMIT,
  RUN_IMAGE_MIME_TYPES,
  TASK_TITLE_LIMIT,
} from "@t3-factory/domain-validation";
import { randomId } from "./lib/ids.ts";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "./api.ts";
import {
  indexedDbImages,
  readImageFile,
  type DraftImageStore,
  type ImageUploads,
} from "./draft-images.ts";

/**
 * Client-local Run preparation. It exists while its prompt has a non-whitespace character or it
 * has an image; Start needs text.
 */
export interface SavedRunDraft {
  readonly id: string;
  readonly segments: readonly PromptSegment[];
  /** Image manifest in attachment order; the bytes live in the draft image store. */
  readonly images: readonly RunImage[];
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

/** Where the user fixes a rejected Start: Agent reporting setup, or the Agent and Flow choices. */
type StartRemedy = "reporting" | "studio";

/** A file the composer did not attach, with why. */
export interface ImageRejection {
  readonly name: string;
  readonly reason: string;
}

interface RunDraft {
  draftId: string | undefined;
  projectId: string;
  flowId: string;
  /** The prompt's text segments; the composer edits them as ordinary text. */
  input: string;
  images: readonly RunImage[];
  imageRejections: readonly ImageRejection[];
  pending: boolean;
  busy: boolean;
  error: string;
  remedy: StartRemedy;
  issues: readonly ValidationIssue[];
  saveFailed: boolean;
}

type Choice = "projectId" | "flowId";

interface Composition {
  projectId: string;
  flowId: string;
  input: string;
  images: readonly RunImage[];
}

const composition = (saved: SavedRunDraft): Composition => ({
  projectId: saved.projectId,
  flowId: saved.flowId,
  input: promptText(saved.segments),
  images: saved.images,
});

const unknownOutcome =
  "Start outcome unknown. Your input and request identity are kept. Check the same request again to recover its Run without creating a duplicate.";

const unsavedUnknownOutcome =
  "Start outcome unknown, and this browser could not save the request for recovery after a reload. Keep this window open and check the same request again to recover its Run without creating a duplicate.";

export function draftTitle(draft: Pick<SavedRunDraft, "segments" | "manualTitle">) {
  const firstLine = promptText(draft.segments)
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

const textSegments = (text: string): PromptSegment[] => (text ? [{ type: "text", text }] : []);

function readSegments(value: unknown): PromptSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.map((segment: unknown) => {
    const { type, text, imageId } = (segment ?? {}) as Record<string, unknown>;
    if (type === "text" && typeof text === "string") return { type, text } as const;
    if (type === "image" && filled(imageId)) return { type, imageId } as const;
    return undefined;
  });
  return segments.every((segment) => segment !== undefined) ? segments : undefined;
}

function readImages(value: unknown): RunImage[] | undefined {
  if (!Array.isArray(value) || value.length > RUN_IMAGE_LIMIT) return undefined;
  const images = value.map((image: unknown) => {
    const { imageId, sha256, name, mimeType, sizeBytes } = (image ?? {}) as Record<string, unknown>;
    if (!filled(imageId) || !isSha256Hex(sha256) || !filled(name)) return undefined;
    if (!RUN_IMAGE_MIME_TYPES.includes(mimeType as RunImage["mimeType"])) return undefined;
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes)) return undefined;
    return { imageId, sha256, name, mimeType: mimeType as RunImage["mimeType"], sizeBytes };
  });
  return images.every((image) => image !== undefined) ? images : undefined;
}

/**
 * The saved prompt. Drafts and submissions saved before images carry `input` text instead; it
 * becomes one text segment without images, under the same request identity.
 */
function readPrompt(value: Record<string, unknown>) {
  if (value.segments === undefined && typeof value.input === "string")
    return { segments: textSegments(value.input), images: [] };
  const segments = readSegments(value.segments);
  const images = readImages(value.images);
  return segments && images ? { segments, images } : undefined;
}

function readSubmission(value: unknown): StartRunInput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const { requestId, projectId, flowId, title, createdAt } = fields;
  const prompt = readPrompt(fields);
  if (!filled(requestId) || !filled(projectId) || !filled(flowId) || !prompt) return undefined;
  if (!filled(promptText(prompt.segments))) return undefined;
  if (!filled(title) || !isCanonicalTimestamp(createdAt)) return undefined;
  return Object.freeze({ requestId, projectId, flowId, ...prompt, title, createdAt });
}

/** A draft exists while it has prompt text or an image. */
const retained = (draft: Pick<SavedRunDraft, "segments" | "images">) =>
  filled(promptText(draft.segments)) || draft.images.length > 0;

function readDraft(value: unknown): SavedRunDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const { id, projectId, flowId, manualTitle, createdAt, listed, submission } = fields;
  const prompt = readPrompt(fields);
  if (!filled(id) || !prompt || !retained(prompt) || typeof projectId !== "string")
    return undefined;
  if (typeof flowId !== "string" || typeof listed !== "boolean") return undefined;
  if (!isCanonicalTimestamp(createdAt)) return undefined;
  if (manualTitle !== undefined && !filled(manualTitle)) return undefined;
  const request = readSubmission(submission);
  if (submission !== undefined && !request) return undefined;
  return {
    id,
    ...prompt,
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

/** Factory's image staging through the API. */
const apiUploads: ImageUploads = {
  has: (image) => api.hasRunImage(image.sha256),
  upload: async (image, data) => {
    await api.stageRunImage(image.sha256, data);
  },
};

const missingDigests = (error: ApiError) =>
  new Set(error.detail.issues.map((issue) => issue.path.replace(/^images\./, "")));

const missingImagesOutcome =
  "Factory still lacks some images of this request. Check the same request to upload them again.";

export function createRunDraft(
  startRun: (submission: StartRunInput) => Promise<{ id: string }> = api.startRun,
  images: { store: DraftImageStore; uploads: ImageUploads } = {
    store: indexedDbImages,
    uploads: apiUploads,
  },
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
  let current: Composition = { projectId: "", flowId: "", input: "", images: [] };
  let currentId: string | undefined;
  let imageRejections: readonly ImageRejection[] = [];
  let error = "";
  let remedy: StartRemedy = "studio";
  let issues: readonly ValidationIssue[] = [];
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
      imageRejections,
      pending: !!saved?.submission,
      busy: !!currentId && inFlight.has(currentId),
      error,
      remedy,
      issues,
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
    const latest = latestDrafts(scope);
    const previous = latest.find((d) => d.id === id) ?? (scope === server ? find(id) : undefined);
    // Another tab's unresolved Start must survive this tab's stale edit, rename or discard.
    const unseenStart = scope === server && !!previous?.submission && !find(id)?.submission;
    if (unseenStart) show(previous);
    const next = unseenStart ? previous : change(previous);
    const others = latest.filter((d) => d.id !== id);
    const result = next ? [...others, next].toSorted(byCreation) : others;
    if (scope !== server)
      return writeSaved(scope, { current: readSaved(scope)?.current, drafts: result });
    const saved = store(scope, result);
    if (!saved) unsaved.set(id, next);
    return saved;
  }
  /** Writes the current server's drafts and open composition, tracking whether the write held. */
  function store(scope: string, result: readonly SavedRunDraft[]) {
    const saved = writeSaved(scope, { current: currentId, drafts: result });
    drafts = result;
    saveFailed = !saved;
    if (saved) unsaved.clear();
    return saved;
  }
  function latestDrafts(scope: string) {
    const stored = readSaved(scope)?.drafts;
    if (scope !== server) return stored ?? [];
    return stored ? withUnsaved(stored) : drafts;
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
    issues = [];
    error = saved?.submission && !inFlight.has(saved.id) ? unknownOutcome : "";
    imageRejections = [];
    if (saved) current = composition(saved);
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
      current = {
        projectId: remembered("project"),
        flowId: remembered("flow"),
        input: "",
        images: [],
      };
    }
    pruneImages(next);
    publish();
  }
  /** Composer load: bytes no saved draft of this server references are deleted. */
  function pruneImages(scope: string) {
    const referenced = new Set(
      drafts.flatMap((saved) => saved.images.map((image) => `${saved.id}/${image.imageId}`)),
    );
    images.store.retainOnly(scope, referenced).catch(() => {
      // Unreferenced bytes stay until the next load; drafts are unaffected.
    });
  }
  function leaveComposition() {
    const leaving = find(currentId);
    if (server === undefined || !leaving || leaving.listed) return false;
    commit(server, leaving.id, (saved) => saved && { ...saved, listed: true });
    return true;
  }
  function save() {
    if (server === undefined) return;
    const prompt = { segments: textSegments(current.input), images: current.images };
    if (!retained(prompt)) {
      const removed = currentId;
      currentId = undefined;
      if (removed) removeDraft(server, removed);
      return;
    }
    const id = currentId ?? randomId();
    currentId = id;
    const { projectId, flowId } = current;
    commit(server, id, (saved) => ({
      ...(saved ?? { id, createdAt: new Date().toISOString(), listed: false }),
      projectId,
      flowId,
      ...prompt,
    }));
  }
  /** Metadata first, then bytes: a reader never finds a reference without its bytes. */
  function removeDraft(scope: string, id: string) {
    commit(scope, id, () => undefined);
    images.store.remove(scope, id).catch(() => {
      // The next composer load deletes bytes no draft references.
    });
  }
  function edit(change: Partial<Pick<RunDraft, Choice | "input">>) {
    if (find(currentId)?.submission) return;
    current = { ...current, ...change };
    error = "";
    issues = [];
    imageRejections = [];
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
        images: [],
      };
    if (server !== undefined) store(server, latestDrafts(server));
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
      current = { ...current, input: "", images: [] };
      error = "";
      issues = [];
      imageRejections = [];
    }
    removeDraft(server, id);
    publish();
  }
  function rejectStart(id: string, failure: unknown, recoverable: boolean) {
    if (id !== currentId) return;
    if (confirmedRejection(failure)) {
      error = failure.message;
      issues = failure.detail.issues;
      remedy = failure.detail.issues.some((issue) => issue.code === "reporting_installation")
        ? "reporting"
        : "studio";
    } else if (failure instanceof ApiError && failure.detail.code === "missing_images")
      error = missingImagesOutcome;
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
        segments: saved.segments,
        images: saved.images,
        title: draftTitle(saved),
        createdAt: saved.createdAt,
      });
    inFlight.add(id);
    const recoverable = commit(requestServer, id, (latest = saved) => ({
      ...latest,
      submission: request,
    }));
    error = "";
    issues = [];
    publish();
    let run;
    try {
      run = await submit(requestServer, request);
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
    removeDraft(requestServer, id);
    if (!shown) {
      publish();
      return;
    }
    // Only the transport result decides Start's outcome; preferences and navigation do not.
    rememberChoice("project", request.projectId);
    rememberChoice("flow", request.flowId);
    current = { ...current, input: "", images: [] };
    publish();
    return run.id;
  }
  /**
   * Stages the request's images Factory lacks, then sends the same Start. Images Factory
   * reports missing at acceptance are uploaded again and the request retried once.
   */
  async function submit(scope: string, request: StartRunInput) {
    await stage(scope, request, request.images, true);
    try {
      return await startRun(request);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.detail.code === "missing_images")) throw failure;
      const missing = missingDigests(failure);
      const lacking = request.images.filter((image) => missing.has(image.sha256));
      await stage(scope, request, lacking, false);
      return startRun(request);
    }
  }
  async function stage(
    scope: string,
    request: StartRunInput,
    pending: readonly RunImage[],
    probe: boolean,
  ) {
    for (const image of pending) {
      if (probe && (await images.uploads.has(image))) continue;
      const data = await images.store.load(scope, request.requestId, image.imageId);
      if (!data) throw Error(`${image.name} is no longer saved in this browser.`);
      await images.uploads.upload(image, data);
    }
  }
  /**
   * Attaches picked images to the open draft. Each file is checked on its own; a rejected file
   * leaves the others and the existing attachments. Identical bytes attach once.
   */
  async function attachImages(files: readonly File[]) {
    const scope = server;
    if (scope === undefined || find(currentId)?.submission) return;
    const id = currentId ?? randomId();
    currentId = id;
    const rejected: ImageRejection[] = [];
    for (const file of files) {
      const outcome = await attachImage(scope, id, file);
      if (outcome === "left") return;
      if (outcome) rejected.push(outcome);
    }
    imageRejections = rejected;
    publish();
  }
  /** A rejection, nothing when attached or already attached, or `left` if the draft changed. */
  async function attachImage(
    scope: string,
    id: string,
    file: File,
  ): Promise<ImageRejection | "left" | undefined> {
    const candidate = await readImageFile(file);
    if (!candidate.ok) return { name: candidate.name, reason: candidate.reason };
    if (current.images.some((image) => image.sha256 === candidate.sha256)) return undefined;
    if (current.images.length >= RUN_IMAGE_LIMIT)
      return { name: candidate.name, reason: `A Run takes at most ${RUN_IMAGE_LIMIT} images.` };
    const image: RunImage = {
      imageId: randomId(),
      sha256: candidate.sha256,
      name: candidate.name,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.data.size,
    };
    try {
      await images.store.save(scope, id, image.imageId, candidate.data);
    } catch {
      return { name: candidate.name, reason: "Browser storage is full or unavailable." };
    }
    if (scope !== server || currentId !== id || find(id)?.submission) return "left";
    current = { ...current, images: [...current.images, image] };
    save();
    return undefined;
  }
  function removeImage(imageId: string) {
    const scope = server;
    const id = currentId;
    if (scope === undefined || !id || find(id)?.submission) return;
    current = { ...current, images: current.images.filter((image) => image.imageId !== imageId) };
    imageRejections = [];
    save();
    if (currentId === id)
      images.store.remove(scope, id, [imageId]).catch(() => {
        // The next composer load deletes bytes no draft references.
      });
    publish();
  }
  /** The open draft's image bytes, for thumbnails and full-size preview. */
  function loadImage(imageId: string) {
    if (server === undefined || !currentId) return Promise.resolve(undefined);
    return images.store.load(server, currentId, imageId);
  }
  function syncFromStorage() {
    if (server === undefined) return;
    const saved = readSaved(server);
    if (!saved) return;
    drafts = withUnsaved(saved.drafts);
    const latest = find(currentId);
    if (latest) {
      current = composition(latest);
    } else if (currentId && !inFlight.has(currentId)) {
      currentId = undefined;
      current = { ...current, input: "", images: [] };
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
    attachImages,
    removeImage,
    loadImage,
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

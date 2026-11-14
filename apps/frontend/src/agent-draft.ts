import { useSyncExternalStore } from "react";
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentExecutionSettings,
  AgentModelOptionDescriptor,
  AgentModelOptionValue,
  AgentEnvironment,
  AgentProviderCapability,
  AgentModelCapability,
} from "@t3-factory/contracts";
import { validateCreateAgent, validateUpdateAgent } from "@t3-factory/domain-validation";
import { api, ApiError } from "./api.ts";
import { OfflineError } from "./transport.ts";
import { randomId } from "./lib/ids.ts";
import type { StudioDefinitions } from "./studio-definitions.ts";

/** Factory writes used by one Agent draft; the HTTP client in the app, fakes in Node tests. */
export type AgentDraftOperations = Pick<
  typeof api,
  "createAgent" | "updateAgent" | "removeAgent" | "duplicateAgent"
>;

/** Studio's saved definitions as one Agent draft follows them, and the writes it sends. */
export type AgentDraftSource = Pick<StudioDefinitions, "getSnapshot" | "subscribe" | "refresh"> &
  AgentDraftOperations;
export type AgentContent = Pick<AgentDefinition, "name" | "prompt" | "execution" | "exits">;

export function optionValue(
  options: readonly AgentModelOptionValue[],
  descriptor: AgentModelOptionDescriptor,
) {
  const selected = options.find((entry) => entry.id === descriptor.id);
  if (selected) return selected.value;
  if (descriptor.default !== undefined) return descriptor.default;
  if (descriptor.values) return descriptor.values[0] ?? "";
  if (descriptor.type === "boolean") return false;
  return descriptor.choices?.[0]?.id ?? "";
}

export function buildOptions(
  descriptors: readonly AgentModelOptionDescriptor[] | undefined,
  current: readonly AgentModelOptionValue[],
): AgentModelOptionValue[] {
  if (!descriptors?.length) return [];
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    value: optionValue(current, descriptor),
  }));
}

function withOptionValue(
  options: readonly AgentModelOptionValue[],
  id: string,
  value: AgentModelOptionValue["value"],
): AgentModelOptionValue[] {
  return options.some((entry) => entry.id === id)
    ? options.map((entry) => (entry.id === id ? { ...entry, value } : entry))
    : [...options, { id, value }];
}

function initialExecution(capabilities: AgentCapabilities | null): AgentExecutionSettings {
  // A provider without Factory reporting cannot run, so it is never preselected.
  const provider = capabilities?.providers.find((entry) => entry.reporting.supported);
  const model = provider?.models[0];
  return {
    environmentId: capabilities?.environments[0]?.environmentId ?? "",
    providerInstanceId: provider?.providerInstanceId ?? "",
    modelId: model?.id ?? "",
    modelOptions: buildOptions(model?.options, []),
  };
}

function contentOf(agent: AgentDefinition): AgentContent {
  return { name: agent.name, prompt: agent.prompt, execution: agent.execution, exits: agent.exits };
}

const sameContent = (a: AgentContent, b: AgentContent) => JSON.stringify(a) === JSON.stringify(b);

function saveRequest(
  agent: AgentDefinition | null,
  draft: AgentContent,
  operations: AgentDraftOperations,
): { error: string } | { submitted: AgentContent; save: () => Promise<AgentDefinition> } {
  if (agent) {
    const validation = validateUpdateAgent({ ...draft, expectedRevision: agent.revision });
    if (!validation.ok) return { error: validation.error.message };
    const { expectedRevision: _, ...submitted } = validation.value;
    return { submitted, save: () => operations.updateAgent(agent.id, validation.value) };
  }
  const validation = validateCreateAgent(draft);
  if (!validation.ok) return { error: validation.error.message };
  const submitted = validation.value;
  return { submitted, save: () => operations.createAgent(submitted) };
}

/**
 * `not-sent`: the window refused to send it while offline or synchronizing. `unknown`: the
 * connection failed after sending, so Factory may or may not have accepted it.
 */
export type AgentSaveOutcome = "pending" | "succeeded" | "rejected" | "not-sent" | "unknown";

/** One save this draft sent: what it submitted, against which revision, and how it ended. */
interface AgentSave {
  readonly outcome: AgentSaveOutcome;
  readonly content: AgentContent;
  /** The revision the save expected; null for a Create. */
  readonly baseline: number | null;
}

function saveFailure(cause: unknown, creating: boolean) {
  if (cause instanceof OfflineError && cause.delivery === "unknown")
    return {
      outcome: "unknown" as const,
      message: creating
        ? "Save outcome unknown. Factory may have created this Agent; check the Agent list before creating it again."
        : "Save outcome unknown. Factory may have saved this Agent; your edits are kept and nothing is retried.",
    };
  return {
    outcome: cause instanceof OfflineError ? ("not-sent" as const) : ("rejected" as const),
    message:
      cause instanceof Error
        ? cause.message
        : "Could not save this Agent. Your edits are still here.",
  };
}

export interface AgentDraftSnapshot {
  /** The saved revision the draft is based on and the next save expects; null for a new Agent. */
  readonly saved: AgentDefinition | null;
  readonly content: AgentContent;
  readonly choices: {
    readonly environments: readonly AgentEnvironment[];
    readonly providers: readonly AgentProviderCapability[];
    readonly selectedProvider: AgentProviderCapability | undefined;
    readonly selectedModel: AgentModelCapability | undefined;
  };
  readonly dirty: boolean;
  /** A save is pending; edits and further writes wait for its reply. */
  readonly saving: boolean;
  /** How the last save ended; null before the first save. */
  readonly saveOutcome: AgentSaveOutcome | null;
  readonly error: string;
  /** The newest revision saved elsewhere while the draft had unsaved changes, until resolved. */
  readonly newer: AgentDefinition | null;
  /** Factory refused a save as stale; resolved through the same comparison as `newer`. */
  readonly stale: boolean;
  /** The comparison of the local draft with `newer` is open. */
  readonly comparing: boolean;
  /** The revision **Load latest revision** is waiting to be confirmed for. */
  readonly confirmingLoad: number | null;
  /** A clean draft just switched to this revision saved elsewhere. */
  readonly updatedTo: number | null;
  /** Studio no longer holds the Agent this draft had seen saved. */
  readonly removed: boolean;
  readonly canSave: boolean;
  readonly deleting: boolean;
  readonly deleteError: string;
}

/**
 * One opened Agent: editable content, worker choices, the saved revision it is based on and
 * its write outcomes. A connected draft follows Studio's saved Agents: a clean draft adopts a
 * newer revision, a dirty one keeps its edits and offers the newer revision for comparison, and
 * this draft's own saves are recognised as its own whichever arrives first, the reply or the
 * delivery. Only synchronized reads are conclusive. The new-Agent form follows nothing until
 * its own Create. A draft belongs to one Studio session and server, so replies reaching a
 * discarded draft change nothing shown.
 */
export function createAgentDraft(
  agent: AgentDefinition | null,
  capabilities: AgentCapabilities | null,
  source: AgentDraftSource,
) {
  let saved = agent;
  let content: AgentContent = agent
    ? contentOf(agent)
    : {
        name: "",
        prompt: "",
        execution: initialExecution(capabilities),
        exits: [{ id: randomId(), name: "done", description: "", messageRequired: false }],
      };
  let baseline = content;
  let lastSave: AgentSave | null = null;
  let error = "";
  let newer: AgentDefinition | null = null;
  let stale = false;
  let comparing = false;
  let confirmingLoad: number | null = null;
  let updatedTo: number | null = null;
  /** A synchronized read held this Agent, so its later absence is a removal, not "not found". */
  let seen = false;
  let removed = false;
  let deleting = false;
  let deleted = false;
  let deleteError = "";
  let snapshot = current();
  const listeners = new Set<() => void>();

  function current(): AgentDraftSnapshot {
    const { environmentId, providerInstanceId, modelId } = content.execution;
    const environments = capabilities?.environments ?? [];
    const providers = environments.some((entry) => entry.environmentId === environmentId)
      ? (capabilities?.providers ?? [])
      : [];
    const selectedProvider = providers.find(
      (entry) => entry.providerInstanceId === providerInstanceId,
    );
    const selectedModel = selectedProvider?.models.find((entry) => entry.id === modelId);
    const saving = lastSave?.outcome === "pending";
    const unknownCreate = !saved && lastSave?.outcome === "unknown";
    return {
      saved,
      content,
      saving,
      saveOutcome: lastSave?.outcome ?? null,
      error,
      newer,
      stale,
      comparing,
      confirmingLoad,
      updatedTo,
      removed,
      canSave: !removed && !saving && !deleting && !newer && !stale && !unknownCreate,
      deleting,
      deleteError,
      choices: { environments, providers, selectedProvider, selectedModel },
      dirty: !sameContent(content, baseline),
    };
  }
  function publish() {
    snapshot = current();
    listeners.forEach((notify) => notify());
  }
  function edit(change: Partial<AgentContent>) {
    if (snapshot.saving || deleting) return;
    content = { ...content, ...change };
    publish();
  }
  function closeResolution() {
    newer = null;
    stale = false;
    comparing = false;
    confirmingLoad = null;
  }
  /** The saved revision replaces the draft, which is clean and shows no conflict or error. */
  function adopt(next: AgentDefinition) {
    saved = next;
    content = contentOf(next);
    baseline = content;
    closeResolution();
    error = "";
  }
  /** A removal is shown at once, even while a save is pending, and beats its late success. */
  function noteAbsence(): boolean {
    if (!seen) return false;
    removed = true;
    closeResolution();
    updatedTo = null;
    return true;
  }
  /** A save whose outcome was unknown reached Factory after all if `latest` holds its content. */
  function recognisesUnknownSave(latest: AgentDefinition): boolean {
    if (lastSave?.outcome !== "unknown" || !sameContent(contentOf(latest), lastSave.content))
      return false;
    saved = latest;
    baseline = contentOf(latest);
    lastSave = { ...lastSave, outcome: "succeeded" };
    error = "";
    return true;
  }
  /** A newer saved revision: a clean draft adopts it, a dirty one names it until resolved. */
  function followNewer(latest: AgentDefinition): boolean {
    if (recognisesUnknownSave(latest)) return true;
    if (sameContent(content, baseline)) {
      adopt(latest);
      updatedTo = latest.revision;
      return true;
    }
    if (newer === latest) return false;
    if (newer?.revision !== latest.revision) confirmingLoad = null;
    newer = latest;
    return true;
  }
  /** Applies Studio's saved Agents to the draft; returns whether anything shown changed. */
  function reconcile(): boolean {
    if (!saved || removed || deleting || deleted) return false;
    const read = source.getSnapshot().agents;
    if (!read.synchronized || !read.value) return false;
    const id = saved.id;
    const latest = read.value.find((entry) => entry.id === id);
    if (!latest) return noteAbsence();
    seen = true;
    // A pending save defers notices; an older revision is a delivery behind its accepted reply.
    if (lastSave?.outcome === "pending" || latest.revision < saved.revision) return false;
    if (latest.revision > saved.revision) return followNewer(latest);
    if (latest === saved) return false;
    saved = latest;
    return true;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Follows Studio's saved Agents until the returned function is called. */
    connect() {
      const unsubscribe = source.subscribe(() => {
        if (reconcile()) publish();
      });
      if (reconcile()) publish();
      return unsubscribe;
    },
    edit,
    exportJson: () => JSON.stringify(content, null, 2),
    async duplicate() {
      if (removed || !saved || snapshot.dirty || snapshot.saving || deleting) return;
      return source.duplicateAgent(saved.id, {});
    },
    setEnvironmentId(id: string) {
      edit({ execution: { ...content.execution, environmentId: id } });
    },
    /** The transient "Updated to revision N" line has been shown long enough. */
    dismissUpdate() {
      if (updatedTo === null) return;
      updatedTo = null;
      publish();
    },
    clearDeleteError() {
      deleteError = "";
      publish();
    },
    async delete() {
      if (removed || !saved || snapshot.saving || deleting) return false;
      deleting = true;
      deleteError = "";
      publish();
      try {
        await source.removeAgent(saved.id);
        deleted = true;
        baseline = content;
        return true;
      } catch (cause) {
        deleteError =
          cause instanceof Error ? cause.message : "Factory could not delete this Agent.";
        return false;
      } finally {
        deleting = false;
        reconcile();
        publish();
      }
    },
    /**
     * Sends the draft against its saved revision, or creates it. Notices wait for the reply;
     * a stale save opens the same comparison as a revision saved elsewhere.
     */
    async save() {
      if (!snapshot.canSave) return;
      const request = saveRequest(saved, content, source);
      if ("error" in request) {
        error = request.error;
        publish();
        return;
      }
      const creating = !saved;
      const sent: AgentSave = {
        outcome: "pending",
        content: request.submitted,
        baseline: saved?.revision ?? null,
      };
      lastSave = sent;
      error = "";
      updatedTo = null;
      publish();
      try {
        const result = await request.save();
        lastSave = { ...sent, outcome: "succeeded" };
        if (removed) return undefined;
        adopt(result);
        return result;
      } catch (cause) {
        const failure = saveFailure(cause, creating);
        lastSave = { ...sent, outcome: failure.outcome };
        error = failure.message;
        if (cause instanceof ApiError && cause.detail.code === "conflict") {
          stale = true;
          // An older server learns the newer revision only by reading the list again.
          source.refresh();
        }
        return undefined;
      } finally {
        reconcile();
        publish();
      }
    },
    /** Opens the comparison with the newest saved revision, reading it first if unknown. */
    compare() {
      if (!newer && !stale) return;
      comparing = true;
      if (!newer) source.refresh();
      publish();
    },
    /** Asks to confirm replacing the draft with `revision`, the revision the comparison shows. */
    requestLoadLatest(revision: number) {
      if (newer?.revision !== revision) return;
      confirmingLoad = revision;
      publish();
    },
    cancelLoadLatest() {
      confirmingLoad = null;
      publish();
    },
    /** Replaces the draft with `revision` if it is still the newest and was confirmed. */
    loadLatest(revision: number) {
      if (!newer || newer.revision !== revision || confirmingLoad !== revision) return;
      adopt(newer);
      publish();
    },
    /** Keeps the edits, unsaved, against `revision` if it is still the newest. */
    keepEdits(revision: number) {
      if (!newer || newer.revision !== revision) return;
      saved = newer;
      baseline = contentOf(newer);
      closeResolution();
      error = "";
      publish();
    },
    /** The user checked the Agent list after an unknown Create, so Create may be sent again. */
    allowCreateAgain() {
      if (saved || lastSave?.outcome !== "unknown") return;
      lastSave = null;
      error = "";
      publish();
    },
    setOption(id: string, value: AgentModelOptionValue["value"]) {
      edit({
        execution: {
          ...content.execution,
          modelOptions: withOptionValue(content.execution.modelOptions, id, value),
        },
      });
    },
    removeOption(id: string) {
      edit({
        execution: {
          ...content.execution,
          modelOptions: content.execution.modelOptions.filter((option) => option.id !== id),
        },
      });
    },
    chooseModel(id: string) {
      const model = snapshot.choices.selectedProvider?.models.find((entry) => entry.id === id);
      edit({
        execution: {
          ...content.execution,
          modelId: id,
          modelOptions: buildOptions(model?.options, content.execution.modelOptions),
        },
      });
    },
    chooseProvider(id: string) {
      const model = snapshot.choices.providers.find((entry) => entry.providerInstanceId === id)
        ?.models[0];
      edit({
        execution: {
          ...content.execution,
          providerInstanceId: id,
          modelId: model?.id ?? "",
          modelOptions: buildOptions(model?.options, content.execution.modelOptions),
        },
      });
    },
  };
}

export type AgentDraftModel = ReturnType<typeof createAgentDraft>;

export function useAgentDraftSnapshot(draft: AgentDraftModel) {
  return useSyncExternalStore(draft.subscribe, draft.getSnapshot);
}

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
  CreateAgentInput,
} from "@t3-factory/contracts";
import { validateCreateAgent, validateUpdateAgent } from "@t3-factory/domain-validation";
import { api } from "./api.ts";
import type { Retained } from "./draft-guard.ts";
import { randomId } from "./lib/ids.ts";
import {
  createSavedDefinitionSync,
  retainedDraft,
  type Presence,
  type SavedView,
} from "./saved-definition-sync.ts";

/** Factory writes used by one Agent draft; the HTTP client in the app, fakes in Node tests. */
export type AgentDraftOperations = Pick<
  typeof api,
  "createAgent" | "updateAgent" | "removeAgent" | "getAgent"
>;
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

function saveRequest(
  agent: AgentDefinition | null,
  draft: AgentContent,
  operations: AgentDraftOperations,
): { error: string } | { save: () => Promise<AgentDefinition> } {
  if (agent) {
    const validation = validateUpdateAgent({ ...draft, expectedRevision: agent.revision });
    if (!validation.ok) return { error: validation.error.message };
    const input = validation.value;
    return { save: () => operations.updateAgent(agent.id, input) };
  }
  const validation = validateCreateAgent(draft);
  if (!validation.ok) return { error: validation.error.message };
  const input = validation.value;
  return { save: () => operations.createAgent(input) };
}

/** The environments, providers and models T3 offers for these worker settings. */
function workerChoices(
  execution: AgentExecutionSettings,
  capabilities: AgentCapabilities | null,
): AgentDraftSnapshot["choices"] {
  const environments = capabilities?.environments ?? [];
  const providers = environments.some((entry) => entry.environmentId === execution.environmentId)
    ? (capabilities?.providers ?? [])
    : [];
  const selectedProvider = providers.find(
    (entry) => entry.providerInstanceId === execution.providerInstanceId,
  );
  const selectedModel = selectedProvider?.models.find((entry) => entry.id === execution.modelId);
  return { environments, providers, selectedProvider, selectedModel };
}

export interface AgentDraftSnapshot {
  readonly presence: Presence;
  /** The saved Agent whose revision the next save expects; null for a new Agent. */
  readonly saved: AgentDefinition | null;
  readonly content: AgentContent;
  readonly choices: {
    readonly environments: readonly AgentEnvironment[];
    readonly providers: readonly AgentProviderCapability[];
    readonly selectedProvider: AgentProviderCapability | undefined;
    readonly selectedModel: AgentModelCapability | undefined;
  };
  readonly dirty: boolean;
  /** What Studio asks about before discarding this draft. */
  readonly retained: Retained;
  readonly saving: boolean;
  readonly error: string;
  /** A newer saved revision than the draft's, or a stale save refused before one was shown. */
  readonly conflict: { readonly revision: number | null } | null;
  /** The saved revision shown beside the draft for comparison. */
  readonly compared: AgentDefinition | null;
  readonly comparing: boolean;
  readonly saveOutcomeUnknown: boolean;
  /** A clean draft took this revision saved elsewhere. */
  readonly updatedTo: number | null;
  readonly deleting: boolean;
  readonly deleteError: string;
  readonly canSave: boolean;
  readonly canDuplicate: boolean;
  readonly canDelete: boolean;
}

/**
 * One opened Agent, or a new one when `id` is null: editable content, worker choices, the saved
 * Agent Studio's source delivers, write outcomes, revision comparison and removal. A new Agent
 * follows the source only after its own create.
 */
export function createAgentDraft(
  id: string | null,
  capabilities: AgentCapabilities | null,
  operations: AgentDraftOperations = api,
) {
  let content: AgentContent = {
    name: "",
    prompt: "",
    execution: initialExecution(capabilities),
    exits: [{ id: randomId(), name: "done", description: "", messageRequired: false }],
  };
  let baseline = content;
  let error = "";
  let deleting = false;
  let deleteError = "";
  const listeners = new Set<() => void>();
  const isDirty = () => JSON.stringify(content) !== JSON.stringify(baseline);
  const sync = createSavedDefinitionSync<AgentDefinition>({
    dirty: isDirty,
    adopt(agent) {
      content = contentOf(agent);
      baseline = content;
      error = "";
    },
    rebind(agent) {
      baseline = contentOf(agent);
      error = "";
    },
    readLatest: () => operations.getAgent(id ?? ""),
    publish,
  });
  let snapshot = current();

  function current(): AgentDraftSnapshot {
    const state = sync.state();
    const dirty = isDirty();
    const creating = id === null && state.baseline === null;
    const present = state.presence === "present";
    const { conflict } = state;
    const idle = !state.saving && !deleting;
    return {
      presence: state.presence,
      saved: state.baseline,
      content,
      saving: state.saving,
      error,
      conflict,
      compared: state.compared,
      comparing: state.comparing,
      saveOutcomeUnknown: state.saveOutcomeUnknown,
      updatedTo: state.updatedTo,
      deleting,
      deleteError,
      choices: workerChoices(content.execution, capabilities),
      dirty,
      retained: retainedDraft(state, dirty),
      canSave: (creating || present) && idle && !conflict,
      canDuplicate: present && idle && !dirty,
      canDelete: present && idle,
    };
  }
  function publish() {
    snapshot = current();
    listeners.forEach((notify) => notify());
  }
  function edit(change: Partial<AgentContent>) {
    const { presence, saving } = sync.state();
    const editable = id === null || presence === "present" || presence === "removed";
    if (!editable || saving || deleting) return;
    content = { ...content, ...change };
    sync.edited();
    publish();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Studio's source view of this Agent; a new Agent ignores it until its own create. */
    observe(view: SavedView<AgentDefinition>) {
      if (id === null) return;
      sync.observe(view);
    },
    /** This editor's Agent as a create or duplicate reply returned it, before the source shows it. */
    acknowledge(agent: AgentDefinition) {
      sync.acknowledge(agent);
      publish();
    },
    edit,
    setEnvironmentId(environmentId: string) {
      edit({ execution: { ...content.execution, environmentId } });
    },
    clearDeleteError() {
      deleteError = "";
      publish();
    },
    async delete() {
      const saved = sync.state().baseline;
      if (!saved || !snapshot.canDelete) return false;
      deleting = true;
      deleteError = "";
      sync.beginRemove();
      publish();
      try {
        await operations.removeAgent(saved.id);
        sync.removeSettled(true);
        baseline = content;
        return true;
      } catch (cause) {
        sync.removeSettled(false);
        deleteError =
          cause instanceof Error ? cause.message : "Factory could not delete this Agent.";
        return false;
      } finally {
        deleting = false;
        publish();
      }
    },
    async save() {
      if (!snapshot.canSave) return;
      const request = saveRequest(sync.state().baseline, content, operations);
      if ("error" in request) {
        error = request.error;
        publish();
        return;
      }
      sync.beginSave();
      error = "";
      publish();
      try {
        const saved = await request.save();
        sync.saveSucceeded(saved);
        return sync.state().presence === "present" ? saved : undefined;
      } catch (cause) {
        if (sync.saveFailed(cause) !== "unknown")
          error =
            cause instanceof Error
              ? cause.message
              : "Could not save this Agent. Your edits are still here.";
        return undefined;
      } finally {
        publish();
      }
    },
    /** Shows the newest saved revision beside the local draft, which stays as it is. */
    async compareLatest() {
      if (await sync.compare()) return;
      error = "Could not load the latest revision. Try again.";
      publish();
    },
    closeComparison: () => sync.closeComparison(),
    /** Replaces the local draft with revision `revision`, if it is still the newest. */
    takeLatest: (revision: number) => sync.takeLatest(revision),
    /** Keeps the local edits, unsaved, against revision `revision` for another explicit save. */
    keepMine: (revision: number) => sync.keepMine(revision),
    /** The local draft as `factory_create_agent` and `POST /api/agents` accept it. */
    createInput(): CreateAgentInput {
      return {
        name: content.name,
        prompt: content.prompt,
        execution: content.execution,
        exits: content.exits,
      };
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

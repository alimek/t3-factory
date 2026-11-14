import { useSyncExternalStore } from "react";
import type {
  CreateFlowInput,
  FlowDraft,
  FlowReadiness,
  ValidationIssue,
} from "@t3-factory/contracts";
import { api, ApiError } from "./api.ts";
import type { Retained } from "./draft-guard.ts";
import {
  createSavedDefinitionSync,
  retainedDraft,
  type Presence,
  type SavedView,
} from "./saved-definition-sync.ts";

/** The part of a Flow its editor changes: what a save writes and a revision conflict compares. */
export type FlowContent = Pick<FlowDraft, "name" | "workspace" | "graph">;

/** The Factory operations one Flow draft uses; the HTTP client in the app, fakes in tests. */
export type FlowDraftOperations = Pick<
  typeof api,
  "getFlow" | "updateFlow" | "validateFlow" | "removeFlow"
>;

/** A newer saved revision than the draft's, and that revision while it is compared. */
export type FlowConflict =
  | { readonly status: "none" }
  | { readonly status: "detected"; readonly revision: number | null }
  | { readonly status: "compared"; readonly latest: FlowDraft };

export interface FlowDraftSnapshot {
  readonly presence: Presence;
  /** The saved Flow whose revision the next save expects; null until the Flow loads. */
  readonly saved: FlowDraft | null;
  readonly content: FlowContent;
  readonly dirty: boolean;
  /** What Studio asks about before discarding this draft. */
  readonly retained: Retained;
  /** A save or readiness check is in flight; edits wait for it. */
  readonly busy: boolean;
  readonly removing: boolean;
  readonly removalError: string;
  readonly error: string;
  readonly issues: readonly ValidationIssue[];
  /** Null while readiness is unknown for the content, revision and Agents shown. */
  readonly readiness: FlowReadiness | null;
  /** Saved Agents changed since an unsaved draft's readiness was known. */
  readonly agentsChanged: boolean;
  readonly conflict: FlowConflict;
  readonly saveOutcomeUnknown: boolean;
  /** A clean draft took this revision saved elsewhere. */
  readonly updatedTo: number | null;
  readonly canSave: boolean;
  readonly canStartRun: boolean;
  readonly canRemove: boolean;
}

const emptyContent: FlowContent = {
  name: "",
  workspace: { mode: "checkout" },
  graph: {
    blocks: [],
    connections: [],
    flowInput: { position: { x: 40, y: 50 }, targetBlockIds: [] },
  },
};

const failure = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** The part of a saved Flow its editor changes. */
export const flowContent = (flow: FlowDraft): FlowContent => ({
  name: flow.name,
  workspace: flow.workspace,
  graph: flow.graph,
});

/**
 * One opened Flow: its local draft beside the saved Flow Studio's source delivers, saving,
 * revision comparison, removal and readiness. Readiness is known only for the exact content,
 * saved revision and saved-Agent generation it describes: a clean draft shows the source's
 * readiness, an unsaved one the result of its own check.
 */
export function createFlowDraft(id: string, operations: FlowDraftOperations = api) {
  let content = emptyContent;
  let dirty = false;
  let busy = false;
  let removing = false;
  let removalError = "";
  let error = "";
  let issues: readonly ValidationIssue[] = [];
  let synchronized = false;
  let agentGeneration: string | null = null;
  let agentsChanged = false;
  /** The last check: the content and revision it validated and the saved Agents it used. */
  let checked: {
    readonly key: string;
    readonly generation: string | null;
    readonly readiness: FlowReadiness;
  } | null = null;
  const listeners = new Set<() => void>();

  const sync = createSavedDefinitionSync<FlowDraft>({
    dirty: () => dirty,
    adopt(flow) {
      content = flowContent(flow);
      dirty = false;
      error = "";
      issues = [];
      checked = null;
      agentsChanged = false;
    },
    rebind() {
      dirty = true;
      error = "";
      issues = [];
    },
    readLatest: () => operations.getFlow(id),
    publish,
  });
  let snapshot: FlowDraftSnapshot = current();

  /** The content and saved revision a readiness result describes. */
  function contentKey() {
    return JSON.stringify([content, sync.state().baseline?.revision ?? null]);
  }

  /**
   * A clean draft shows the readiness its source delivered with the shown Agents, never a save
   * reply's; an unsaved draft shows its check only while the Agents it used are the ones shown.
   */
  function shownReadiness(): FlowReadiness | null {
    const state = sync.state();
    if (!synchronized || state.presence !== "present" || state.savedElsewhere !== null) return null;
    if (!dirty) return state.confirmed ? (state.baseline?.readiness ?? null) : null;
    return checked?.key === contentKey() && checked.generation === agentGeneration
      ? checked.readiness
      : null;
  }

  function current(): FlowDraftSnapshot {
    const state = sync.state();
    const present = state.presence === "present";
    const conflict: FlowConflict = state.compared
      ? { status: "compared", latest: state.compared }
      : state.conflict
        ? { status: "detected", revision: state.conflict.revision }
        : { status: "none" };
    const readiness = shownReadiness();
    return {
      presence: state.presence,
      saved: state.baseline,
      content,
      dirty,
      retained: retainedDraft(state, dirty),
      busy,
      removing,
      removalError,
      error,
      issues,
      readiness,
      agentsChanged: dirty && agentsChanged,
      conflict,
      saveOutcomeUnknown: state.saveOutcomeUnknown,
      updatedTo: state.updatedTo,
      canSave: present && !busy && conflict.status === "none",
      canStartRun: present && !busy && !dirty && !!readiness?.ready,
      canRemove: present && !busy && !removing,
    };
  }
  function publish() {
    snapshot = current();
    listeners.forEach((notify) => notify());
  }
  function reject(cause: unknown, fallback: string) {
    error = failure(cause, fallback);
    if (cause instanceof ApiError) issues = cause.detail.issues;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Studio's source view of this Flow; an unsynchronized view makes readiness unknown. */
    observe(view: SavedView<FlowDraft>) {
      synchronized = view.synchronized;
      sync.observe(view);
      publish();
    },
    /** The saved Agents' identity and revisions; a change makes unsaved readiness unknown. */
    observeAgents(generation: string) {
      if (generation === agentGeneration) return;
      if (agentGeneration !== null && dirty) agentsChanged = true;
      agentGeneration = generation;
      publish();
    },
    /** Any edit marks the draft unsaved; errors stay shown. Removed Flows stay editable. */
    edit(change: Partial<FlowContent>) {
      const { presence } = sync.state();
      if ((presence !== "present" && presence !== "removed") || busy) return;
      content = { ...content, ...change };
      dirty = true;
      sync.edited();
      publish();
    },
    /** Saves the content against the saved revision; a stale revision enters the conflict. */
    async save() {
      const against = sync.state().baseline;
      if (!against || !snapshot.canSave) return;
      busy = true;
      error = "";
      issues = [];
      sync.beginSave();
      publish();
      try {
        sync.saveSucceeded(
          await operations.updateFlow(id, { ...content, expectedRevision: against.revision }),
        );
      } catch (cause) {
        if (sync.saveFailed(cause) !== "unknown") reject(cause, "Could not save Flow.");
      } finally {
        busy = false;
        publish();
      }
    },
    /** Accepted removal clears the guard before the caller navigates away. */
    async remove() {
      if (!snapshot.canRemove) return false;
      removing = true;
      removalError = "";
      sync.beginRemove();
      publish();
      try {
        await operations.removeFlow(id);
        sync.removeSettled(true);
        dirty = false;
        return true;
      } catch (cause) {
        sync.removeSettled(false);
        removalError = failure(cause, "Could not remove Flow.");
        return false;
      } finally {
        removing = false;
        publish();
      }
    },
    clearRemovalError() {
      removalError = "";
      publish();
    },
    /** Validates the content without saving it; the result applies only to what it checked. */
    async check() {
      const against = sync.state().baseline;
      if (!against || busy || sync.state().presence !== "present") return;
      busy = true;
      error = "";
      issues = [];
      const key = contentKey();
      const asked = agentGeneration;
      publish();
      try {
        const { agentGeneration: used, ...readiness } = await operations.validateFlow({
          ...content,
          expectedRevision: against.revision,
        });
        // Servers before protocol 12 do not say which Agents they used.
        checked = { key, generation: used ?? asked, readiness };
        if (checked.generation === agentGeneration) agentsChanged = false;
      } catch (cause) {
        if (key === contentKey()) reject(cause, "Could not check Flow.");
      } finally {
        busy = false;
        publish();
      }
    },
    beginInteraction: sync.beginInteraction,
    endInteraction: sync.endInteraction,
    /** Shows the newest saved revision beside the local draft, which stays as it is. */
    async compareLatest() {
      if (await sync.compare()) return;
      error = "Could not load the latest revision. Try again.";
      publish();
    },
    /** Replaces the local draft with revision `revision`, if it is still the newest. */
    takeLatest: (revision: number) => sync.takeLatest(revision),
    /** Keeps the local content, unsaved, against revision `revision` for another explicit save. */
    keepLocal: (revision: number) => sync.keepMine(revision),
    /** The local draft as `factory_create_flow` and `POST /api/flows` accept it. */
    createInput(): CreateFlowInput {
      return { name: content.name, graph: content.graph, workspace: content.workspace };
    },
  };
}

export type FlowDraftModel = ReturnType<typeof createFlowDraft>;

export function useFlowDraftSnapshot(draft: FlowDraftModel) {
  return useSyncExternalStore(draft.subscribe, draft.getSnapshot);
}

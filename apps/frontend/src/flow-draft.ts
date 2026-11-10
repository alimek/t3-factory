import { useSyncExternalStore } from "react";
import type { FlowDraft, FlowReadiness, ValidationIssue } from "@t3-factory/contracts";
import { api, ApiError } from "./api.ts";

/** The part of a Flow its editor changes: what a save writes and a revision conflict compares. */
export type FlowContent = Pick<FlowDraft, "name" | "workspace" | "graph">;

/** The Factory operations one Flow draft uses; the HTTP client in the app, fakes in tests. */
export type FlowDraftOperations = Pick<
  typeof api,
  "getFlow" | "updateFlow" | "validateFlow" | "removeFlow"
>;

/** A save refused because Factory holds a newer revision, and that revision once compared. */
export type FlowConflict =
  | { readonly status: "none" }
  | { readonly status: "detected" }
  | { readonly status: "compared"; readonly latest: FlowDraft };

export interface FlowDraftSnapshot {
  readonly status: "loading" | "failed" | "loaded";
  /** The saved Flow whose revision the next save expects; null until the Flow loads. */
  readonly saved: FlowDraft | null;
  /** After a load, an accepted save or taking the latest Flow, its graph is `saved.graph`. */
  readonly content: FlowContent;
  readonly dirty: boolean;
  /** A save or readiness check is in flight; edits wait for it. */
  readonly busy: boolean;
  readonly removing: boolean;
  readonly removalError: string;
  readonly error: string;
  readonly issues: readonly ValidationIssue[];
  /** Null while readiness is unknown. */
  readonly readiness: FlowReadiness | null;
  readonly conflict: FlowConflict;
  readonly canSave: boolean;
  readonly canStartRun: boolean;
}

const noConflict: FlowConflict = { status: "none" };

const failure = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/**
 * One opened Flow: its saved revision, local edits, save and revision-conflict resolution, and
 * readiness. Opening loads the Flow once; the editor reports its visibility and refreshed saved
 * Agents, and the draft decides when readiness is read again.
 */
export function createFlowDraft(id: string, operations: FlowDraftOperations = api) {
  let status: FlowDraftSnapshot["status"] = "loading";
  let saved: FlowDraft | null = null;
  let content: FlowContent = {
    name: "",
    workspace: { mode: "checkout" },
    graph: {
      blocks: [],
      connections: [],
      flowInput: { position: { x: 40, y: 50 }, targetBlockIds: [] },
    },
  };
  let dirty = false;
  let busy = false;
  let removing = false;
  let removalError = "";
  let error = "";
  let issues: readonly ValidationIssue[] = [];
  let readiness: FlowReadiness | null = null;
  let conflict = noConflict;
  let visible = false;
  /** Advances whenever a pending readiness answer must no longer apply. */
  let readinessRequest = 0;
  let snapshot: FlowDraftSnapshot = current();
  const listeners = new Set<() => void>();

  function current(): FlowDraftSnapshot {
    const loaded = status === "loaded";
    return {
      status,
      saved,
      content,
      dirty,
      busy,
      removing,
      removalError,
      error,
      issues,
      readiness,
      conflict,
      canSave: loaded && !busy && conflict.status === "none",
      canStartRun: loaded && !busy && !dirty && !!readiness?.ready,
    };
  }
  function publish() {
    snapshot = current();
    listeners.forEach((notify) => notify());
  }
  /** Readiness becomes unknown; a visible, loaded, clean draft re-reads only its readiness. */
  function refreshReadiness() {
    readiness = null;
    const request = ++readinessRequest;
    if (!visible || status !== "loaded" || dirty) return;
    operations.getFlow(id).then(
      (flow) => {
        if (request !== readinessRequest) return;
        readiness = flow.readiness;
        publish();
      },
      (cause: unknown) => {
        if (request !== readinessRequest) return;
        error = failure(cause, "Could not load Flow.");
        publish();
      },
    );
  }
  /** The saved Flow replaces the draft, which is clean and shows no conflict or error. */
  function adopt(flow: FlowDraft) {
    status = "loaded";
    saved = flow;
    content = { name: flow.name, workspace: flow.workspace, graph: flow.graph };
    dirty = false;
    conflict = noConflict;
    error = "";
    issues = [];
    refreshReadiness();
  }
  /** Runs one save or check: edits and further requests wait until it answers. */
  async function run(operation: () => Promise<void>) {
    busy = true;
    error = "";
    issues = [];
    ++readinessRequest;
    publish();
    try {
      await operation();
    } finally {
      busy = false;
      publish();
    }
  }
  const unresolved = () => conflict.status !== "none";
  function reject(cause: unknown, fallback: string) {
    error = failure(cause, fallback);
    if (cause instanceof ApiError) issues = cause.detail.issues;
  }

  operations.getFlow(id).then(
    (flow) => {
      adopt(flow);
      publish();
    },
    (cause: unknown) => {
      status = "failed";
      error = failure(cause, "Could not load Flow.");
      publish();
    },
  );

  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Any edit marks the draft unsaved and makes readiness unknown; errors stay shown. */
    edit(change: Partial<FlowContent>) {
      if (status !== "loaded" || busy) return;
      content = { ...content, ...change };
      dirty = true;
      refreshReadiness();
      publish();
    },
    /** Saves the content against the saved revision; a stale revision enters the conflict. */
    async save() {
      const against = saved;
      if (!against || !snapshot.canSave) return;
      await run(async () => {
        try {
          adopt(
            await operations.updateFlow(id, { ...content, expectedRevision: against.revision }),
          );
        } catch (cause) {
          reject(cause, "Could not save Flow.");
          if (cause instanceof ApiError && cause.detail.code === "conflict")
            conflict = { status: "detected" };
        }
      });
    },
    /** Accepted removal clears the guard before the caller navigates away. */
    async remove() {
      if (!saved || busy || removing) return false;
      removing = true;
      removalError = "";
      publish();
      try {
        await operations.removeFlow(id);
        dirty = false;
        readiness = null;
        ++readinessRequest;
        return true;
      } catch (cause) {
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
    /** Validates the content without saving it. */
    async check() {
      const against = saved;
      if (!against || busy) return;
      await run(async () => {
        const asked = readinessRequest;
        try {
          const checked = await operations.validateFlow({
            ...content,
            expectedRevision: against.revision,
          });
          if (asked === readinessRequest) readiness = checked;
        } catch (cause) {
          if (asked === readinessRequest) reject(cause, "Could not check Flow.");
        }
      });
    },
    reportVisibility(next: boolean) {
      if (next === visible) return;
      visible = next;
      refreshReadiness();
      publish();
    },
    /** The editor's saved Agents were read again, which can change this Flow's readiness. */
    reportAgentsRefreshed() {
      refreshReadiness();
      publish();
    },
    /** Loads the latest saved Flow beside the local draft, which stays as it is. */
    async compareLatest() {
      if (!unresolved() || busy) return;
      const comparing = conflict;
      try {
        const latest = await operations.getFlow(id);
        // Another comparison, resolution or later conflict may have replaced this one meanwhile.
        if (conflict === comparing) conflict = { status: "compared", latest };
      } catch {
        // A readiness check started meanwhile reports its own outcome.
        if (conflict === comparing && !busy)
          error = "Could not load the latest revision. Try again.";
      }
      publish();
    },
    /** Replaces the local draft with the compared Flow. */
    takeLatest() {
      if (conflict.status !== "compared") return;
      adopt(conflict.latest);
      publish();
    },
    /** Keeps the local content, unsaved, against the compared revision for another explicit save. */
    keepLocal() {
      if (conflict.status !== "compared") return;
      saved = conflict.latest;
      conflict = noConflict;
      error = "";
      issues = [];
      dirty = true;
      refreshReadiness();
      publish();
    },
  };
}

export type FlowDraftModel = ReturnType<typeof createFlowDraft>;

export function useFlowDraftSnapshot(draft: FlowDraftModel) {
  return useSyncExternalStore(draft.subscribe, draft.getSnapshot);
}

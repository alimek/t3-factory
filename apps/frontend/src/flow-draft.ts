import { useSyncExternalStore } from "react";
import type {
  AgentDefinition,
  FlowDraft,
  FlowGraph,
  FlowReadiness,
  ValidationIssue,
} from "@t3-factory/contracts";
import { flowAgentRevisions } from "@t3-factory/domain-validation";
import { api, ApiError } from "./api.ts";
import type { StudioDefinitions } from "./studio-definitions.ts";
import { OfflineError } from "./transport.ts";

/** The part of a Flow its editor changes: what a save writes and a revision conflict compares. */
export type FlowContent = Pick<FlowDraft, "name" | "workspace" | "graph">;

/** Studio's saved definitions, which hold this Flow's saved revisions, and its Flow writes. */
export type FlowDraftSource = Pick<
  StudioDefinitions,
  "getSnapshot" | "subscribe" | "refresh" | "updateFlow" | "removeFlow"
>;

/** The Factory operations one Flow draft uses beyond Studio's; the HTTP client in the app. */
export type FlowDraftOperations = Pick<typeof api, "validateFlow">;

/**
 * Factory holds a newer revision than the unsaved draft's baseline: saved elsewhere or found by
 * a refused save. `revision` names the newest one Studio holds (null until it arrives), and a
 * comparison always shows that newest revision.
 */
export type FlowConflict =
  | { readonly status: "none" }
  | { readonly status: "detected"; readonly revision: number | null }
  | { readonly status: "compared"; readonly latest: FlowDraft };

/**
 * This editor's last save: `pending` until Factory answers, `unknown` when the connection was
 * lost or the server session changed before the answer could be trusted.
 */
export type FlowSaveState = "idle" | "pending" | "succeeded" | "rejected" | "unknown";

export interface FlowDraftSnapshot {
  readonly status: "loading" | "failed" | "loaded";
  /** The saved Flow whose revision the next save expects; null until the Flow loads. */
  readonly saved: FlowDraft | null;
  /** After a load, an accepted save or taking the latest Flow, its graph is `saved.graph`. */
  readonly content: FlowContent;
  readonly dirty: boolean;
  /** The Flow was removed after it loaded; the draft stays as it is. */
  readonly removed: boolean;
  /** The revision saved elsewhere that this clean draft last switched to, until the next change. */
  readonly updatedTo: number | null;
  /** A save or readiness check is in flight; edits wait for it. */
  readonly busy: boolean;
  readonly saveState: FlowSaveState;
  readonly removing: boolean;
  readonly removalError: string;
  readonly error: string;
  readonly issues: readonly ValidationIssue[];
  /** Null while readiness is unknown. */
  readonly readiness: FlowReadiness | null;
  /** An Agent this unsaved draft places changed since readiness was last known; check again. */
  readonly agentsChanged: boolean;
  readonly conflict: FlowConflict;
  readonly canSave: boolean;
  readonly canStartRun: boolean;
}

const noConflict: FlowConflict = { status: "none" };

const failure = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const contentOf = (flow: FlowDraft): FlowContent => ({
  name: flow.name,
  workspace: flow.workspace,
  graph: flow.graph,
});

/** JSON with sorted object keys, so equal content compares equal whatever its key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const sameContent = (a: FlowContent, b: FlowContent) => canonical(a) === canonical(b);

/**
 * The saved revisions of the Agents `graph` places, comparable with a validation answer's; null
 * while Studio holds no Agents.
 */
const agentStamp = (graph: FlowGraph, agents: readonly AgentDefinition[] | null) =>
  agents ? canonical(flowAgentRevisions(graph, agents)) : null;

const unknownOutcome =
  "Save outcome unknown. The connection was lost before Factory answered; your draft is kept and nothing is sent again.";

/**
 * One opened Flow: its saved revision, local edits, save and revision-conflict resolution, and
 * readiness. It follows the Flow through Studio's saved definitions while open.
 */
export function createFlowDraft(
  id: string,
  source: FlowDraftSource,
  operations: FlowDraftOperations = api,
  /** This editor's own create answer, which can arrive before Studio receives the Flow. */
  created?: FlowDraft,
) {
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
  /** Studio's current saved Flows no longer include this loaded Flow. */
  let removed = false;
  /** A current read of Studio's saved Flows has included this Flow; only then can it be removed. */
  let known = false;
  /** The user asked to compare before Studio held the newer revision; it is shown on arrival. */
  let comparing = false;
  let updatedTo: number | null = null;
  let busy = false;
  let saveState: FlowSaveState = "idle";
  /** What the last save sent, against which revision and in which server session. */
  let submitted: { content: FlowContent; baseline: number; session: number } | null = null;
  /** Advances when the server's protocol changes; replies from an earlier session are unknown. */
  let session = 0;
  let protocol: number | undefined;
  let removing = false;
  let removalError = "";
  let error = "";
  let issues: readonly ValidationIssue[] = [];
  let checked: FlowReadiness | null = null;
  let agentsChanged = false;
  let conflict = noConflict;
  /** Advances whenever a pending readiness answer must no longer apply. */
  let readinessRequest = 0;
  /** Drags, wire gestures, Auto-arrange runs and text entry in progress; adoption waits for them. */
  let interactions = 0;
  let snapshot: FlowDraftSnapshot;
  const listeners = new Set<() => void>();

  /** The Flow as Studio's saved definitions hold it now; undefined while unknown or absent. */
  function latest() {
    return source.getSnapshot().flows.value?.find((flow) => flow.id === id);
  }
  /** The saved readiness of a clean draft whose revision Studio currently holds. */
  function savedReadiness() {
    const flows = source.getSnapshot().flows;
    const flow = latest();
    if (dirty || busy || removed || !flows.synchronized || !saved || !flow) return null;
    return flow.revision === saved.revision ? flow.readiness : null;
  }
  function current(): FlowDraftSnapshot {
    const loaded = status === "loaded";
    const readiness = checked ?? savedReadiness();
    return {
      status,
      saved,
      content,
      dirty,
      removed,
      updatedTo,
      busy,
      saveState,
      removing,
      removalError,
      error,
      issues,
      readiness,
      agentsChanged,
      conflict,
      canSave: loaded && !busy && conflict.status === "none",
      canStartRun: loaded && !busy && !dirty && !!readiness?.ready,
    };
  }
  function publish() {
    snapshot = current();
    listeners.forEach((notify) => notify());
  }
  /** A shown readiness check no longer applies, and an answer still pending is dropped. */
  function forgetCheck() {
    checked = null;
    ++readinessRequest;
  }
  /** The saved Flow replaces the draft, which is clean and shows no conflict or error. */
  function adopt(flow: FlowDraft) {
    status = "loaded";
    saved = flow;
    content = contentOf(flow);
    dirty = false;
    conflict = noConflict;
    comparing = false;
    error = "";
    issues = [];
    agentsChanged = false;
    forgetCheck();
  }
  function observed() {
    const { flows, agents } = source.getSnapshot();
    return { flow: latest()?.revision, synchronized: flows.synchronized, agents: agents.value };
  }
  let seen = observed();
  /**
   * A shown readiness result stops applying as soon as the Flow's saved revision changes, the
   * Flow is removed, Studio loses synchronization or an Agent the draft places changes, also
   * while adoption waits for an interaction. A clean draft then shows the saved Flow's
   * readiness, delivered with those Agents; an unsaved draft waits for another check.
   */
  function observe() {
    const next = observed();
    const placed =
      seen.agents !== null &&
      next.agents !== null &&
      agentStamp(content.graph, seen.agents) !== agentStamp(content.graph, next.agents);
    if (placed && dirty) agentsChanged = true;
    if (next.flow !== seen.flow || (seen.synchronized && !next.synchronized) || placed)
      forgetCheck();
    seen = next;
  }
  /** Opens the Flow from Studio's saved Flows, or reports why it cannot be opened. */
  function load(flow: FlowDraft | undefined) {
    const { flows } = source.getSnapshot();
    if (flow) adopt(flow);
    else if (flows.synchronized || flows.error) {
      status = "failed";
      error = flows.error?.message ?? "Flow not found.";
    }
  }
  /** A current read without the Flow, once one had it, means it was removed. */
  function noteAbsence() {
    // The echo of this editor's own submitted removal is not a removal elsewhere.
    if (!source.getSnapshot().flows.synchronized || !known || removed || removing) return;
    removed = true;
    comparing = false;
    conflict = noConflict;
  }
  /** What the save whose answer was lost sent, when `flow` is its revision. */
  function lostSave(flow: FlowDraft) {
    if (saveState !== "unknown" || !submitted) return null;
    return sameContent(contentOf(flow), submitted.content) ? submitted.content : null;
  }
  /** The save whose answer was lost did reach Factory: its revision is this draft's own. */
  function acknowledgeLostSave(flow: FlowDraft, sent: FlowContent) {
    if (sameContent(content, sent)) adopt(flow);
    else saved = flow;
    saveState = "succeeded";
    error = "";
  }
  /** A newer revision replaces a clean draft and is named beside an unsaved one. */
  function follow(flow: FlowDraft) {
    if (!dirty) {
      adopt(flow);
      updatedTo = flow.revision;
    } else if (conflict.status === "compared" || comparing) {
      comparing = false;
      conflict = { status: "compared", latest: flow };
    } else conflict = { status: "detected", revision: flow.revision };
  }
  /**
   * Brings the draft up to what Studio's saved definitions hold now. A newer revision waits
   * while a save is pending, or while a clean draft is being interacted with; a removal does not.
   */
  function reconcile() {
    const { flows } = source.getSnapshot();
    const flow = latest();
    if (flow && flows.synchronized) known = true;
    if (comparing && flows.error) {
      comparing = false;
      error = "Could not load the latest revision. Try again.";
    }
    if (status !== "loaded") return load(flow);
    if (!flow) return noteAbsence();
    // Only adoption into a clean draft waits for an interaction; it would replace the graph.
    const waiting = saveState === "pending" || (interactions > 0 && !dirty);
    if (!saved || flow.revision <= saved.revision || waiting) return;
    const sent = lostSave(flow);
    if (sent) acknowledgeLostSave(flow, sent);
    else follow(flow);
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
      reconcile();
      publish();
    }
  }
  const unresolved = () => conflict.status !== "none";
  if (created) adopt(created);
  reconcile();
  snapshot = current();
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
    /** Follows the Flow through Studio's saved definitions until the returned function runs. */
    open() {
      observe();
      reconcile();
      publish();
      return source.subscribe(() => {
        observe();
        reconcile();
        publish();
      });
    },
    /**
     * A drag, wire gesture, Auto-arrange run or text entry begins. A newer revision for a clean
     * draft waits until every one has ended, then is adopted only if the draft is still clean;
     * the returned function ends this one and does nothing when called again.
     */
    interact() {
      ++interactions;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        --interactions;
        reconcile();
        publish();
      };
    },
    /** Any edit marks the draft unsaved and makes readiness unknown; errors stay shown. */
    edit(change: Partial<FlowContent>) {
      if (status !== "loaded" || busy) return;
      content = { ...content, ...change };
      dirty = true;
      updatedTo = null;
      forgetCheck();
      publish();
    },
    /** Saves the content against the saved revision; a stale revision enters the conflict. */
    async save() {
      const against = saved;
      if (!against || !snapshot.canSave) return;
      const sent = { content, baseline: against.revision, session };
      submitted = sent;
      saveState = "pending";
      updatedTo = null;
      const lost = (cause?: unknown) =>
        sent.session !== session || (cause instanceof OfflineError && cause.delivery === "unknown");
      await run(async () => {
        try {
          const accepted = await source.updateFlow(id, {
            ...content,
            expectedRevision: against.revision,
          });
          if (lost()) {
            saveState = "unknown";
            error = unknownOutcome;
            return;
          }
          saveState = "succeeded";
          // A removal that arrived meanwhile wins: the draft never looks current again.
          if (!removed) adopt(accepted);
        } catch (cause) {
          if (lost(cause)) {
            saveState = "unknown";
            error = unknownOutcome;
            return;
          }
          saveState = "rejected";
          reject(cause, "Could not save Flow.");
          // Reconciling afterwards names the newer revision once Studio holds it.
          if (cause instanceof ApiError && cause.detail.code === "conflict")
            conflict = { status: "detected", revision: null };
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
        await source.removeFlow(id);
        dirty = false;
        forgetCheck();
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
          const { agentRevisions, ...answer } = await operations.validateFlow({
            ...content,
            expectedRevision: against.revision,
          });
          // An Agent change Studio has not delivered yet also makes the answer stale. Older
          // servers name no revisions; their answers rely on the request alone.
          const shown = agentStamp(content.graph, source.getSnapshot().agents.value);
          const matches = !agentRevisions || canonical(agentRevisions) === shown;
          if (asked !== readinessRequest || !matches) return;
          checked = answer;
          agentsChanged = false;
        } catch (cause) {
          if (asked === readinessRequest) reject(cause, "Could not check Flow.");
        }
      });
    },
    /** The connected server's protocol; a change starts a new session that fences pending replies. */
    reportProtocol(next: number) {
      if (protocol !== undefined && next !== protocol) ++session;
      protocol = next;
    },
    /** The editor was hidden: a readiness check shown or still in flight no longer applies. */
    hide() {
      forgetCheck();
      publish();
    },
    /**
     * Shows the latest saved Flow beside the local draft, which stays as it is. Until Studio
     * holds a newer revision (an older server re-reads its saved Flows), it is shown on arrival.
     */
    compareLatest() {
      if (!unresolved() || busy) return;
      error = "";
      comparing = true;
      reconcile();
      if (comparing) source.refresh();
      publish();
    },
    /**
     * Replaces the local draft with compared `revision`; nothing happens once a newer revision
     * or a removal has replaced the comparison the user acted on.
     */
    takeLatest(revision: number) {
      if (conflict.status !== "compared" || conflict.latest.revision !== revision) return;
      adopt(conflict.latest);
      publish();
    },
    /**
     * Keeps the local content, unsaved, against compared `revision` for another explicit save,
     * only while that revision is still the one compared.
     */
    keepLocal(revision: number) {
      if (conflict.status !== "compared" || conflict.latest.revision !== revision) return;
      saved = conflict.latest;
      conflict = noConflict;
      error = "";
      issues = [];
      dirty = true;
      forgetCheck();
      publish();
    },
  };
}

export type FlowDraftModel = ReturnType<typeof createFlowDraft>;

export function useFlowDraftSnapshot(draft: FlowDraftModel) {
  return useSyncExternalStore(draft.subscribe, draft.getSnapshot);
}

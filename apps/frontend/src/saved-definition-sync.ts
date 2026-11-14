import { ApiError } from "./api.ts";
import type { Retained } from "./draft-guard.ts";
import { OfflineError } from "./transport.ts";

interface Saved {
  readonly id: string;
  readonly revision: number;
}

/** What Studio's saved-definition source shows for one id. */
export interface SavedView<D> {
  /** The saved definition, or undefined when the source does not hold it. */
  readonly definition: D | undefined;
  /** Only a synchronized view says whether the definition exists. */
  readonly synchronized: boolean;
}

/**
 * `loading` until a synchronized view answers; `missing` when the first one lacks the id (a fresh
 * link); `removed` when a definition loaded in this session leaves the source.
 */
export type Presence = "loading" | "present" | "missing" | "removed";

export interface SavedSyncState<D> {
  readonly presence: Presence;
  /** The saved revision the draft edits against; the next save expects it. */
  readonly baseline: D | null;
  /** The newest saved revision the source delivered. */
  readonly latest: D | null;
  /**
   * The baseline is the copy Studio's source delivered, not only a save or create reply: its
   * status fields describe the same committed state as the rest of the source.
   */
  readonly confirmed: boolean;
  /** A newer revision the draft has not adopted because it holds unsaved changes. */
  readonly savedElsewhere: number | null;
  /** The comparison shows this revision beside the draft; it follows newer revisions. */
  readonly compared: D | null;
  readonly comparing: boolean;
  /**
   * A newer saved revision than the draft's, or a stale save refused before the source showed
   * one (`revision` null); the draft resolves it before saving again.
   */
  readonly conflict: { readonly revision: number | null } | null;
  readonly saving: boolean;
  /** The last save's reply was lost: it may or may not have been accepted. */
  readonly saveOutcomeUnknown: boolean;
  /** The removal this editor submitted, as opposed to one made elsewhere. */
  readonly removedHere: boolean;
  /** Set when a clean draft took a revision saved elsewhere; cleared by the next edit. */
  readonly updatedTo: number | null;
}

export interface SavedSyncHooks<D> {
  dirty(): boolean;
  /** Replaces the local draft with a saved definition. */
  adopt(definition: D): void;
  /** The draft keeps its content but now edits against this saved definition. */
  rebind(definition: D): void;
  /** Reads the current saved definition when the source shows nothing newer to compare. */
  readLatest(): Promise<D>;
  publish(): void;
}

/** What Studio asks about before discarding a draft: a removal elsewhere, or unsaved changes. */
export function retainedDraft(state: SavedSyncState<Saved>, dirty: boolean): Retained {
  if (state.presence === "removed" && !state.removedHere) return "removed";
  return dirty ? "dirty" : null;
}

/**
 * How a save attempt ended, from the error it threw: only a lost reply leaves the outcome
 * unknown; any answer from Factory, or a request never sent, is known.
 */
function saveFailure(cause: unknown): "rejected" | "not-sent" | "unknown" {
  if (!(cause instanceof OfflineError)) return "rejected";
  return cause.delivery === "not-sent" ? "not-sent" : "unknown";
}

/**
 * Reconciles one open editor's local draft with Studio's saved-definition source: the first
 * load, newer revisions saved elsewhere, removal, this editor's own saves and removals, revision
 * comparison and interactions that defer adoption. Removal is final: a late save success never
 * makes a removed definition current again.
 */
export function createSavedDefinitionSync<D extends Saved>(hooks: SavedSyncHooks<D>) {
  let presence: Presence = "loading";
  let baseline: D | null = null;
  let latest: D | null = null;
  /** The last definition the source itself delivered. */
  let delivered: D | null = null;
  let comparing = false;
  let staleSave = false;
  let saving = false;
  let saveOutcomeUnknown = false;
  let removing = false;
  let removedHere = false;
  let updatedTo: number | null = null;
  let interactions = 0;

  const newer = () =>
    baseline && latest && latest.revision > baseline.revision ? latest.revision : null;

  function take(definition: D) {
    baseline = definition;
    hooks.adopt(definition);
    comparing = false;
    staleSave = false;
  }

  /** Applies what the source holds now, unless a save or interaction defers it. */
  function reconcile() {
    if (saving || presence !== "present" || !latest) return;
    if (!baseline) {
      take(latest);
      return;
    }
    if (latest.revision === baseline.revision) {
      // The same revision delivered again as a whole entity: status fields may have changed.
      baseline = latest;
      return;
    }
    if (latest.revision < baseline.revision || interactions > 0 || hooks.dirty()) return;
    take(latest);
    updatedTo = latest.revision;
  }

  function receive(definition: D) {
    if (!latest || definition.revision >= latest.revision) latest = definition;
  }

  return {
    state(): SavedSyncState<D> {
      // A pending save's own revision may arrive first; its notices wait for the reply.
      const savedElsewhere = saving ? null : newer();
      return {
        presence,
        baseline,
        latest,
        confirmed: baseline !== null && baseline === delivered,
        savedElsewhere,
        compared: comparing && savedElsewhere !== null ? latest : null,
        comparing,
        conflict:
          presence === "present" && (savedElsewhere !== null || staleSave)
            ? { revision: savedElsewhere }
            : null,
        saving,
        saveOutcomeUnknown,
        removedHere,
        updatedTo,
      };
    },
    /** Applies the source's current view of this definition. */
    observe(view: SavedView<D>) {
      if (!view.synchronized || presence === "removed") return;
      if (view.definition) {
        delivered = view.definition;
        receive(view.definition);
        if (presence !== "present") presence = "present";
      } else if (presence === "loading") presence = "missing";
      else if (presence === "present") {
        presence = "removed";
        removedHere ||= removing;
        comparing = false;
      }
      reconcile();
      hooks.publish();
    },
    /** A create or duplicate reply arrived before the source shows the new definition. */
    acknowledge(definition: D) {
      if (presence === "removed") return;
      receive(definition);
      presence = "present";
      reconcile();
    },
    edited() {
      updatedTo = null;
    },
    beginSave() {
      saving = true;
      staleSave = false;
      saveOutcomeUnknown = false;
    },
    /**
     * The reply's revision becomes the baseline; a removal that arrived meanwhile wins. The
     * source's copy of the same revision is kept: it may carry newer status fields.
     */
    saveSucceeded(saved: D) {
      saving = false;
      if (presence === "removed") return;
      if (!latest || saved.revision > latest.revision) latest = saved;
      presence = "present";
      take(latest.revision === saved.revision ? latest : saved);
      reconcile();
    },
    /** Returns the failure kind; a stale refusal enters the comparison path. */
    saveFailed(cause: unknown) {
      saving = false;
      const kind = saveFailure(cause);
      if (kind === "unknown") saveOutcomeUnknown = true;
      if (kind === "rejected" && cause instanceof ApiError && cause.detail.code === "conflict")
        staleSave = true;
      reconcile();
      return kind;
    },
    beginRemove() {
      removing = true;
    },
    removeSettled(accepted: boolean) {
      removing = false;
      if (accepted) removedHere = true;
    },
    /** A drag, wire gesture, arrange or text composition defers adopting a newer revision. */
    beginInteraction() {
      interactions++;
    },
    endInteraction() {
      if (interactions === 0) return;
      interactions--;
      reconcile();
      hooks.publish();
    },
    /**
     * Shows the newest saved revision beside the draft, reading it when the source has none
     * newer. Returns whether a newer revision is shown.
     */
    async compare() {
      if (presence !== "present" || !baseline) return false;
      comparing = true;
      hooks.publish();
      if (newer() === null) {
        try {
          receive(await hooks.readLatest());
        } catch {
          // The notice keeps offering the comparison.
        }
        hooks.publish();
      }
      return newer() !== null;
    },
    closeComparison() {
      comparing = false;
      hooks.publish();
    },
    /** Replaces the draft with revision `revision`, only if it is still the newest. */
    takeLatest(revision: number) {
      if (presence !== "present" || saving || !latest || latest.revision !== revision) return false;
      take(latest);
      hooks.publish();
      return true;
    },
    /** Keeps the draft unsaved against revision `revision`, only if it is still the newest. */
    keepMine(revision: number) {
      if (presence !== "present" || saving || !latest || latest.revision !== revision) return false;
      baseline = latest;
      hooks.rebind(latest);
      comparing = false;
      staleSave = false;
      hooks.publish();
      return true;
    },
  };
}

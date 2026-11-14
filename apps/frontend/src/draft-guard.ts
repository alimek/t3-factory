import { useEffect } from "react";

export type DraftGuardState = { readonly dirty: boolean; readonly removed: boolean };
export type ReportDraft = (id: string, state: DraftGuardState) => void;

/** What Studio's unsaved-change guard needs from an opened Flow or Agent draft. */
interface GuardedDraft {
  getSnapshot(): DraftGuardState;
  subscribe(notify: () => void): () => void;
}

/**
 * Tells Studio's guard when this draft's unsaved changes or retained removal change, from the draft's own
 * notification, so the guard is current before any navigation that follows. Ending the editor
 * clears only this draft's entry, and later completions report nothing.
 */
export function useDraftGuard(draft: GuardedDraft, id: string, reportDraft: ReportDraft) {
  useEffect(() => {
    let state = draft.getSnapshot();
    reportDraft(id, state);
    const unsubscribe = draft.subscribe(() => {
      const next = draft.getSnapshot();
      if (next.dirty === state.dirty && next.removed === state.removed) return;
      state = next;
      reportDraft(id, next);
    });
    return () => {
      unsubscribe();
      reportDraft(id, { dirty: false, removed: false });
    };
  }, [draft, id, reportDraft]);
}

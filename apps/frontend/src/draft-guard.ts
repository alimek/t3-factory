import { useEffect } from "react";

/** What Studio's unsaved-change guard needs from an opened Flow or Agent draft. */
interface GuardedDraft {
  getSnapshot(): { readonly dirty: boolean };
  subscribe(notify: () => void): () => void;
}

/**
 * Tells Studio's guard when this draft's unsaved changes change, from the draft's own
 * notification, so the guard is current before any navigation that follows. Ending the editor
 * clears only this draft's entry, and later completions report nothing.
 */
export function useDraftGuard(
  draft: GuardedDraft,
  id: string,
  reportDraft: (id: string, dirty: boolean) => void,
) {
  useEffect(() => {
    let dirty = draft.getSnapshot().dirty;
    const unsubscribe = draft.subscribe(() => {
      const next = draft.getSnapshot().dirty;
      if (next === dirty) return;
      dirty = next;
      reportDraft(id, next);
    });
    return () => {
      unsubscribe();
      reportDraft(id, false);
    };
  }, [draft, id, reportDraft]);
}

import { useEffect } from "react";

/** What Studio asks before discarding: unsaved changes, or a draft whose definition was removed. */
export type Retained = "dirty" | "removed" | null;

/** What Studio's discard guard needs from an opened Flow or Agent draft. */
interface GuardedDraft {
  getSnapshot(): { readonly retained: Retained };
  subscribe(notify: () => void): () => void;
}

/**
 * Tells Studio's guard when what this draft retains changes, from the draft's own notification,
 * so the guard is current before any navigation that follows. Ending the editor clears only
 * this draft's entry, and later completions report nothing.
 */
export function useDraftGuard(
  draft: GuardedDraft,
  id: string,
  reportDraft: (id: string, retained: Retained) => void,
) {
  useEffect(() => {
    let retained = draft.getSnapshot().retained;
    const unsubscribe = draft.subscribe(() => {
      const next = draft.getSnapshot().retained;
      if (next === retained) return;
      retained = next;
      reportDraft(id, next);
    });
    return () => {
      unsubscribe();
      reportDraft(id, null);
    };
  }, [draft, id, reportDraft]);
}

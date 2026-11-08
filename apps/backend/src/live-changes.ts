import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";

export type LiveScope =
  | { readonly kind: "connection" }
  /** Navigation (when held) and a set of Runs, read and delivered together. */
  | { readonly kind: "view"; readonly navigation: boolean; readonly runIds: ReadonlySet<string> }
  /** The Run composer's Project catalog and Flows. */
  | { readonly kind: "launchChoices" };

interface Watcher {
  readonly scope: LiveScope;
  /** Open means the scope may have changed since the subscriber last read it. */
  readonly dirty: Latch.Latch;
}

/**
 * In-memory post-commit change hints. Writers call these only after their transaction
 * commits (or after an authoritative in-memory connection transition). A hint only marks
 * watchers dirty; subscribers re-read committed state themselves, so publication is
 * synchronous, bounded and can neither block nor fail the writer.
 */
export function makeLiveChanges() {
  const watchers = new Set<Watcher>();
  const mark = (affected: (scope: LiveScope) => boolean) => {
    for (const watcher of watchers) if (affected(watcher.scope)) watcher.dirty.openUnsafe();
  };
  return {
    /** Every Run change may also change its navigation row. */
    runChanged(runId: string) {
      mark((scope) => scope.kind === "view" && (scope.navigation || scope.runIds.has(runId)));
    },
    /** Navigation rows and the composer's catalog show project titles and availability. */
    projectsChanged() {
      mark(
        (scope) => (scope.kind === "view" && scope.navigation) || scope.kind === "launchChoices",
      );
    },
    /** Flow and Agent definitions decide which Flows the composer offers and their readiness. */
    definitionsChanged() {
      mark((scope) => scope.kind === "launchChoices");
    },
    /** The catalog derives project availability from the current connection. */
    connectionChanged() {
      mark((scope) => scope.kind === "connection" || scope.kind === "launchChoices");
    },
    /** Registered for the caller's scope; register before reading a snapshot. */
    watch(scope: LiveScope) {
      return Effect.acquireRelease(
        Effect.sync(() => {
          const watcher: Watcher = { scope, dirty: Latch.makeUnsafe(false) };
          watchers.add(watcher);
          return watcher;
        }),
        (watcher) => Effect.sync(() => watchers.delete(watcher)),
      ).pipe(Effect.map((watcher) => watcher.dirty));
    },
  };
}
export type LiveChanges = ReturnType<typeof makeLiveChanges>;

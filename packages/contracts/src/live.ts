import type { RunDetail, RunNavigationEntry, T3Connection } from "./index.ts";

/**
 * Live delivery over the shared window connection. Every scope starts with an authoritative
 * `snapshot`; later messages carry complete values of changed logical entities after their
 * durable commit. A reconnect or visibility gap subscribes again and receives a new snapshot;
 * no message is ever replayed.
 */
export const LIVE_PATH = "/api/live";

export type ConnectionLiveMessage =
  | { readonly _tag: "snapshot"; readonly connection: T3Connection }
  | { readonly _tag: "changed"; readonly connection: T3Connection }
  /** Only the observation time moved; every other field is unchanged. */
  | { readonly _tag: "checked"; readonly checkedAt: string | null };

export type NavigationLiveMessage =
  | { readonly _tag: "snapshot"; readonly rows: readonly RunNavigationEntry[] }
  | {
      readonly _tag: "changed";
      /** Complete replacement rows; clients order by `createdAt` and `creationKey`. */
      readonly upserts: readonly RunNavigationEntry[];
      readonly removals: readonly string[];
    };

type Entity<K extends keyof RunDetail> = RunDetail[K] extends readonly (infer A)[] ? A : never;

/** Run collections whose entities are replaced whole by a stable identity. */
export const runEntityKeys = {
  blocks: (block: Entity<"blocks">) => block.blockId,
  activations: (activation: Entity<"activations">) => activation.id,
  threadBindings: (binding: Entity<"threadBindings">) => binding.id,
  reports: (report: Entity<"reports">) => report.id,
  recoveries: (recovery: Entity<"recoveries">) => recovery.intentId,
  humanOccurrences: (occurrence: Entity<"humanOccurrences">) => occurrence.id,
  attention: (matter: Entity<"attention">) => matter.id,
  executions: (execution: Entity<"executions">) => execution.bindingId,
  intents: (intent: Entity<"intents">) => intent.id,
  rootWork: (work: Entity<"rootWork">) => work.executionId,
} as const;
export type RunEntityCollection = keyof typeof runEntityKeys;

export type RunEntityChanges = {
  readonly [K in RunEntityCollection]?: {
    readonly upserts: readonly Entity<K>[];
    readonly removals: readonly string[];
  };
};

/**
 * Run fields that are neither an entity collection, the immutable history (`events`), the
 * Captured `definitions` nor the internal concurrency `generation`.
 */
export type RunHeader = Omit<
  RunDetail,
  RunEntityCollection | "events" | "definitions" | "generation"
>;

export type RunLiveMessage =
  | { readonly _tag: "snapshot"; readonly run: RunDetail }
  /** One committed change set; clients apply every part together. */
  | {
      readonly _tag: "changed";
      readonly header?: RunHeader;
      readonly entities: RunEntityChanges;
      /** New immutable timeline entries, ascending by `sequence`. */
      readonly events: RunDetail["events"];
    }
  /**
   * Observation times moved without a semantic change. Freshness and execution state
   * changes are never sent here.
   */
  | {
      readonly _tag: "observed";
      readonly blocks: readonly { readonly blockId: string; readonly observedAt: string | null }[];
      readonly executions: readonly {
        readonly bindingId: string;
        readonly observedAt: string | null;
      }[];
      readonly runCoordinatorObservedAt?: string | null;
    };

function replaceEntities<K extends RunEntityCollection>(
  run: { -readonly [K in keyof RunDetail]: RunDetail[K] },
  collection: K,
  changes: RunEntityChanges,
) {
  const change = changes[collection] as
    | { readonly upserts: RunDetail[K]; readonly removals: readonly string[] }
    | undefined;
  if (!change) return;
  // The collection selects both the entity type and its identity function.
  const identity = runEntityKeys[collection] as (entity: RunDetail[K][number]) => string;
  const upserts = new Map(change.upserts.map((entity) => [identity(entity), entity]));
  const removals = new Set(change.removals);
  const entities = run[collection].flatMap((entity) => {
    const id = identity(entity);
    const replacement = upserts.get(id) ?? entity;
    upserts.delete(id);
    return removals.has(id) ? [] : [replacement];
  });
  run[collection] = [...entities, ...upserts.values()].filter(
    (entity) => !removals.has(identity(entity)),
  ) as RunDetail[K];
}

/**
 * Folds one committed change into the Run a client holds. Untouched entities keep their
 * identity; timeline entries at or below the current maximum sequence are never duplicated.
 */
export function applyRunChange(
  run: RunDetail,
  message: Exclude<RunLiveMessage, { readonly _tag: "snapshot" }>,
): RunDetail {
  if (message._tag === "changed") {
    const next = { ...run, ...message.header };
    for (const collection of Object.keys(runEntityKeys) as RunEntityCollection[])
      replaceEntities(next, collection, message.entities);
    let sequence = run.events.reduce((max, event) => Math.max(max, event.sequence), 0);
    const events = message.events.filter((event) => {
      if (event.sequence <= sequence) return false;
      sequence = event.sequence;
      return true;
    });
    if (events.length) next.events = [...run.events, ...events];
    return next;
  }
  const blocks = new Map(message.blocks.map((block) => [block.blockId, block.observedAt]));
  const executions = new Map(
    message.executions.map((execution) => [execution.bindingId, execution.observedAt]),
  );
  return {
    ...run,
    blocks: run.blocks.map((block) =>
      blocks.has(block.blockId) ? { ...block, observedAt: blocks.get(block.blockId)! } : block,
    ),
    executions: run.executions.map((execution) =>
      executions.has(execution.bindingId)
        ? { ...execution, observedAt: executions.get(execution.bindingId)! }
        : execution,
    ),
    runCoordinator:
      run.runCoordinator && message.runCoordinatorObservedAt !== undefined
        ? { ...run.runCoordinator, observedAt: message.runCoordinatorObservedAt }
        : run.runCoordinator,
  };
}

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

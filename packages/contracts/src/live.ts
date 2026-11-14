import type { AgentDefinition } from "./agent.ts";
import type { FlowDraft } from "./flow.ts";
import type { OperationError } from "./result.ts";
import type { ProjectCatalog } from "./project.ts";
import type { RunDetail, RunNavigationEntry } from "./run.ts";
import type { T3Connection } from "./connection.ts";
import type { T3Appearance } from "./appearance.ts";

/**
 * Live delivery over the shared window connection. Every scope starts with an authoritative
 * `snapshot`; later messages carry complete values of changed logical entities after their
 * durable commit. A reconnect or visibility gap subscribes again and receives a new snapshot;
 * no message is ever replayed.
 */
export const LIVE_PATH = "/api/live";

/** Every live delivery is an envelope; the first one of a subscription holds its snapshot. */
export interface LiveEnvelope<M> {
  /**
   * The value was read with no relevant change arriving during the read, and no later read
   * failed. A scope is synchronized, and mutations are enabled, only while its latest applied
   * envelope is current: a snapshot raced by commits stays unsynchronized through its catch-up,
   * and a failed re-read marks the scope unsynchronized until a later read succeeds.
   */
  readonly current: boolean;
  /** Empty when only `current` changed. */
  readonly messages: readonly M[];
}

export type ConnectionLiveMessage =
  | { readonly _tag: "snapshot"; readonly connection: T3Connection }
  | { readonly _tag: "changed"; readonly connection: T3Connection }
  /** Only the observation time moved; every other field is unchanged. */
  | { readonly _tag: "checked"; readonly checkedAt: string | null };

/** Theme-color status and presentation; never gates mutations or execution. */
export type AppearanceLiveMessage =
  | { readonly _tag: "snapshot"; readonly appearance: T3Appearance }
  | { readonly _tag: "changed"; readonly appearance: T3Appearance };

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
  waitArrivals: (arrival: Entity<"waitArrivals">) => arrival.id,
  continuationVisits: (visit: Entity<"continuationVisits">) => visit.id,
  attention: (matter: Entity<"attention">) => matter.id,
  executions: (execution: Pick<Entity<"executions">, "bindingId" | "executionId">) =>
    JSON.stringify([execution.bindingId, execution.executionId]),
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
        readonly executionId: string;
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
    message.executions.map((execution) => [
      runEntityKeys.executions(execution),
      execution.observedAt,
    ]),
  );
  return {
    ...run,
    blocks: run.blocks.map((block) =>
      blocks.has(block.blockId) ? { ...block, observedAt: blocks.get(block.blockId)! } : block,
    ),
    executions: run.executions.map((execution) =>
      executions.has(runEntityKeys.executions(execution))
        ? { ...execution, observedAt: executions.get(runEntityKeys.executions(execution))! }
        : execution,
    ),
    runCoordinator:
      run.runCoordinator && message.runCoordinatorObservedAt !== undefined
        ? { ...run.runCoordinator, observedAt: message.runCoordinatorObservedAt }
        : run.runCoordinator,
  };
}

/** At most this many Runs share one window's view subscription. */
export const RUN_VIEW_LIMIT = 20;

/**
 * Navigation and the window's open Runs travel in one subscription: each envelope comes from one
 * read transaction, so one commit's Run and navigation changes are delivered and applied together.
 */
export type RunViewLiveMessage =
  | { readonly _tag: "navigation"; readonly message: NavigationLiveMessage }
  | { readonly _tag: "run"; readonly runId: string; readonly message: RunLiveMessage }
  /** The Run does not exist. Final for that Run only; the rest of the view stays live. */
  | { readonly _tag: "missing"; readonly runId: string; readonly error: OperationError };

/** What the Run composer offers: the Project catalog and every Flow with its readiness. */
export interface LaunchChoices {
  readonly catalog: ProjectCatalog;
  /** Ordered by `createdAt` descending, then `id`. */
  readonly flows: readonly FlowDraft[];
}

export type LaunchChoicesLiveMessage =
  | { readonly _tag: "snapshot"; readonly choices: LaunchChoices }
  | {
      readonly _tag: "changed";
      /** The complete catalog, when more than project observation times changed. */
      readonly catalog?: ProjectCatalog;
      /** Complete replacement Flows by id; clients order them as `LaunchChoices.flows`. */
      readonly flows?: {
        readonly upserts: readonly FlowDraft[];
        readonly removals: readonly string[];
      };
    }
  /** Only these projects' observation times moved; every other catalog field is unchanged. */
  | {
      readonly _tag: "observed";
      readonly projects: readonly { readonly id: string; readonly observedAt: string }[];
    };

/** Studio's saved definitions: every current Agent with its settings status and every Flow with its readiness. */
export interface StudioDefinitions {
  /** Ordered by the backend: most recently saved first. */
  readonly agents: readonly AgentDefinition[];
  /** Ordered by `createdAt` descending, then `id`. */
  readonly flows: readonly FlowDraft[];
}

/** Complete replacement entities by stable id and removed ids, applied atomically. */
export interface DefinitionChanges<T> {
  readonly upserts: readonly T[];
  readonly removals: readonly string[];
}

/**
 * Agents and Flows of one read transaction. A change carries whole entities: an Agent change can
 * change a Flow's readiness without changing the Flow's revision.
 */
export type DefinitionsLiveMessage =
  | { readonly _tag: "snapshot"; readonly definitions: StudioDefinitions }
  | {
      readonly _tag: "changed";
      readonly agents?: DefinitionChanges<AgentDefinition>;
      readonly flows?: DefinitionChanges<FlowDraft>;
    };

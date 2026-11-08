import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Stream from "effect/Stream";
import {
  runEntityKeys,
  type ConnectionLiveMessage,
  type NavigationLiveMessage,
  type OperationError,
  type Result,
  type RunDetail,
  type RunEntityCollection,
  type RunHeader,
  type RunLiveMessage,
  type RunNavigationEntry,
  type T3Connection,
} from "@t3-factory/contracts";
import type { LiveChanges, LiveScope } from "./live-changes.ts";

/** Scoped live observation exposed by the public Factory seam. */
export interface LiveStreams {
  readonly watchConnection: () => Stream.Stream<ConnectionLiveMessage, OperationError>;
  readonly watchNavigation: () => Stream.Stream<NavigationLiveMessage, OperationError>;
  readonly watchRun: (runId: string) => Stream.Stream<RunLiveMessage, OperationError>;
}

type Read<A> = Effect.Effect<Result<A>, unknown>;

/**
 * Registers before the snapshot read, so a commit racing the snapshot marks the scope dirty.
 * Each later pull waits for a hint, re-reads the committed value and emits only its difference
 * from the last value sent: hints coalesce while the consumer is slow, and history is neither
 * lost nor repeated.
 */
function watch<A, M>(
  changes: LiveChanges,
  scope: LiveScope,
  read: Read<A>,
  snapshot: (value: A) => M,
  diff: (sent: A, current: A) => readonly M[],
): Stream.Stream<M, OperationError> {
  const current = read.pipe(
    Effect.orDie,
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
    ),
  );
  return Stream.unwrap(
    Effect.gen(function* () {
      const dirty = yield* changes.watch(scope);
      let sent = yield* current;
      // Retry the synchronization barrier when a commit raced the read. Keep the final
      // dirty hint open after the bound so continuous writes cannot starve the snapshot.
      for (let attempt = 1; dirty.isOpen() && attempt < 3; attempt++) {
        dirty.closeUnsafe();
        sent = yield* current;
      }
      const next = Effect.gen(function* () {
        while (true) {
          yield* dirty.await;
          // Closed before the read: a hint arriving during the read schedules another pass.
          dirty.closeUnsafe();
          const value = yield* current;
          const messages = diff(sent, value);
          sent = value;
          if (Arr.isReadonlyArrayNonEmpty(messages)) return messages;
        }
      });
      return Stream.concat(Stream.succeed(snapshot(sent)), Stream.fromPull(Effect.succeed(next)));
    }),
  );
}

function connectionDiff(sent: T3Connection, current: T3Connection): ConnectionLiveMessage[] {
  if (Equal.equals(sent, current)) return [];
  return Equal.equals({ ...sent, checkedAt: null }, { ...current, checkedAt: null })
    ? [{ _tag: "checked", checkedAt: current.checkedAt }]
    : [{ _tag: "changed", connection: current }];
}

function navigationDiff(
  sent: readonly RunNavigationEntry[],
  current: readonly RunNavigationEntry[],
): NavigationLiveMessage[] {
  const previous = new Map(sent.map((row) => [row.id, row]));
  const upserts = current.filter((row) => !Equal.equals(previous.get(row.id), row));
  const present = new Set(current.map((row) => row.id));
  const removals = sent.filter((row) => !present.has(row.id)).map((row) => row.id);
  return upserts.length || removals.length ? [{ _tag: "changed", upserts, removals }] : [];
}

const nonHeaderFields = new Set<string>([
  ...Object.keys(runEntityKeys),
  "events",
  "definitions",
  "generation",
]);
const runHeader = (run: RunDetail) =>
  Object.fromEntries(
    Object.entries(run).filter(([field]) => !nonHeaderFields.has(field)),
  ) as unknown as RunHeader;
const withoutCoordinatorObservation = (header: RunHeader) =>
  header.runCoordinator === null
    ? header
    : { ...header, runCoordinator: { ...header.runCoordinator, observedAt: null } };

interface Observation {
  readonly id: string;
  readonly observedAt: string | null;
}

/** The changed header, or only the Run coordinator's observation time when nothing else moved. */
function headerDiff(
  sent: RunDetail,
  current: RunDetail,
): { readonly header?: RunHeader; readonly runCoordinatorObservedAt?: string | null } {
  const before = runHeader(sent);
  const after = runHeader(current);
  if (Equal.equals(before, after)) return {};
  return Equal.equals(withoutCoordinatorObservation(before), withoutCoordinatorObservation(after))
    ? { runCoordinatorObservedAt: current.runCoordinator?.observedAt ?? null }
    : { header: after };
}

type Observable = { readonly observedAt?: string | null };
const observationOnly = (before: object | undefined, entity: Observable) =>
  before !== undefined &&
  Equal.equals({ ...before, observedAt: null }, { ...entity, observedAt: null });

/**
 * Replacements and removals of one collection by stable identity. With `observable`, an
 * entity whose only change is `observedAt` is reported as an observation instead.
 */
function collectionDiff(
  key: (entity: unknown) => string,
  sent: readonly object[],
  current: readonly object[],
  observable: boolean,
) {
  const previous = new Map(sent.map((entity) => [key(entity), entity]));
  const upserts: unknown[] = [];
  const observed: Observation[] = [];
  for (const entity of current) {
    const id = key(entity);
    const before = previous.get(id);
    previous.delete(id);
    if (Equal.equals(before, entity)) continue;
    if (observable && observationOnly(before, entity))
      observed.push({ id, observedAt: (entity as Observable).observedAt ?? null });
    else upserts.push(entity);
  }
  return { upserts, removals: [...previous.keys()], observed };
}

/**
 * Header and entity replacements per stable identity, new timeline entries by sequence, and
 * observation times that moved without any semantic change as compact metadata.
 */
function runDiff(sent: RunDetail, current: RunDetail): RunLiveMessage[] {
  const { header, runCoordinatorObservedAt } = headerDiff(sent, current);
  const entities: Record<string, { upserts: unknown[]; removals: string[] }> = {};
  const observed: Partial<Record<RunEntityCollection, Observation[]>> = {};
  for (const collection of Object.keys(runEntityKeys) as RunEntityCollection[]) {
    const diff = collectionDiff(
      runEntityKeys[collection] as (entity: unknown) => string,
      sent[collection],
      current[collection],
      collection === "blocks" || collection === "executions",
    );
    observed[collection] = diff.observed;
    if (diff.upserts.length || diff.removals.length)
      entities[collection] = { upserts: diff.upserts, removals: diff.removals };
  }
  const lastSequence = sent.events.reduce((max, event) => Math.max(max, event.sequence), 0);
  const events = current.events.filter((event) => event.sequence > lastSequence);
  const blocks = (observed.blocks ?? []).map(({ id, observedAt }) => ({ blockId: id, observedAt }));
  const executionObservations = new Map(
    (observed.executions ?? []).map(({ id, observedAt }) => [id, observedAt]),
  );
  const executions = current.executions.flatMap((execution) => {
    const id = runEntityKeys.executions(execution);
    return executionObservations.has(id)
      ? [
          {
            bindingId: execution.bindingId,
            executionId: execution.executionId,
            observedAt: executionObservations.get(id)!,
          },
        ]
      : [];
  });
  const messages: RunLiveMessage[] = [];
  if (header || Object.keys(entities).length || events.length)
    messages.push({
      _tag: "changed",
      ...(header ? { header } : {}),
      entities,
      events,
    });
  if (blocks.length || executions.length || runCoordinatorObservedAt !== undefined)
    messages.push({
      _tag: "observed",
      blocks,
      executions,
      ...(runCoordinatorObservedAt !== undefined ? { runCoordinatorObservedAt } : {}),
    });
  return messages;
}

export function makeLiveStreams(
  changes: LiveChanges,
  reads: {
    readonly getConnection: () => Read<T3Connection>;
    readonly listRunNavigation: () => Read<readonly RunNavigationEntry[]>;
    readonly getRun: (id: string) => Read<RunDetail>;
  },
): LiveStreams {
  return {
    watchConnection: () =>
      watch(
        changes,
        { kind: "connection" },
        reads.getConnection(),
        (connection) => ({ _tag: "snapshot", connection }),
        connectionDiff,
      ),
    watchNavigation: () =>
      watch(
        changes,
        { kind: "navigation" },
        reads.listRunNavigation(),
        (rows) => ({ _tag: "snapshot", rows }),
        navigationDiff,
      ),
    watchRun: (runId) =>
      watch(
        changes,
        { kind: "run", runId },
        reads.getRun(runId),
        (run) => ({ _tag: "snapshot", run }),
        runDiff,
      ),
  };
}

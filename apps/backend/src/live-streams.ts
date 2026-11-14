import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import {
  runEntityKeys,
  type AppearanceLiveMessage,
  type ConnectionLiveMessage,
  type DefinitionsLiveMessage,
  type DefinitionVersions,
  type FlowDraft,
  type LaunchChoices,
  type LaunchChoicesLiveMessage,
  type LiveEnvelope,
  type NavigationLiveMessage,
  type OperationError,
  type ProjectCatalog,
  type Result,
  type RunDetail,
  type RunEntityCollection,
  type RunHeader,
  type RunLiveMessage,
  type RunNavigationEntry,
  type RunViewLiveMessage,
  type T3Appearance,
  type T3Connection,
} from "@t3-factory/contracts";
import type { LiveChanges, LiveScope } from "./live-changes.ts";

/** Scoped live observation exposed by the public Factory seam. */
export interface LiveStreams {
  readonly watchConnection: () => Stream.Stream<
    LiveEnvelope<ConnectionLiveMessage>,
    OperationError
  >;
  /** Navigation (when wanted) and the given Runs, each envelope from one read transaction. */
  readonly watchRunView: (view: {
    readonly navigation: boolean;
    readonly runIds: readonly string[];
  }) => Stream.Stream<LiveEnvelope<RunViewLiveMessage>, OperationError>;
  /** The Run composer's Project catalog and Flows with their readiness. */
  readonly watchLaunchChoices: () => Stream.Stream<
    LiveEnvelope<LaunchChoicesLiveMessage>,
    OperationError
  >;
  /** Which Flows and Agents are saved and their latest revisions, for Studio. */
  readonly watchDefinitions: () => Stream.Stream<
    LiveEnvelope<DefinitionsLiveMessage>,
    OperationError
  >;
  /** Theme-color status and the inherited presentation, for approved clients only. */
  readonly watchAppearance: () => Stream.Stream<
    LiveEnvelope<AppearanceLiveMessage>,
    OperationError
  >;
}

type Read<A> = Effect.Effect<Result<A>, unknown>;

const rereadRetry = "1 second";

/**
 * Registers before the snapshot read, so a commit racing the snapshot marks the scope dirty.
 * Each later pull waits for a hint, re-reads the committed value and sends only its difference
 * from the last value sent: hints coalesce while the consumer is slow, and history is neither
 * lost nor repeated. An envelope is current only when its read completed with no hint arriving
 * during it, so a raced read is followed by catch-up; every change of currency is sent, and a
 * failed re-read sends a non-current envelope and retries.
 */
function watch<A, M>(
  changes: LiveChanges,
  scope: LiveScope,
  read: Effect.Effect<A, OperationError>,
  snapshot: (value: A) => readonly M[],
  diff: (sent: A, current: A) => readonly M[],
): Stream.Stream<LiveEnvelope<M>, OperationError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const dirty = yield* changes.watch(scope);
      let sent = yield* read;
      // Re-read a snapshot a commit raced, a bounded number of times so continuous writes
      // cannot starve it; a snapshot that is not current is followed by catch-up.
      for (let attempt = 1; attempt < 3 && dirty.isOpen(); attempt++) {
        dirty.closeUnsafe();
        sent = yield* read;
      }
      let sentCurrent = !dirty.isOpen();
      let failed = false;
      const first: LiveEnvelope<M> = { current: sentCurrent, messages: snapshot(sent) };
      const next = Effect.gen(function* () {
        while (true) {
          if (failed) yield* Effect.sleep(rereadRetry);
          else yield* dirty.await;
          // Closed before the read: a hint arriving during the read schedules another pass.
          dirty.closeUnsafe();
          const result = yield* Effect.exit(read);
          if (Exit.isFailure(result)) {
            // Only the snapshot read ends the scope. A failed re-read keeps the last value sent,
            // reports the scope as not current and retries.
            failed = true;
            if (!sentCurrent) continue;
            sentCurrent = false;
            const envelope: LiveEnvelope<M> = { current: false, messages: [] };
            return [envelope] as const;
          }
          failed = false;
          const messages = diff(sent, result.value);
          sent = result.value;
          const current = !dirty.isOpen();
          if (messages.length === 0 && current === sentCurrent) continue;
          sentCurrent = current;
          const envelope: LiveEnvelope<M> = { current, messages };
          return [envelope] as const;
        }
      });
      return Stream.concat(Stream.succeed(first), Stream.fromPull(Effect.succeed(next)));
    }),
  );
}

function connectionDiff(sent: T3Connection, current: T3Connection): ConnectionLiveMessage[] {
  if (Equal.equals(sent, current)) return [];
  return Equal.equals({ ...sent, checkedAt: null }, { ...current, checkedAt: null })
    ? [{ _tag: "checked", checkedAt: current.checkedAt }]
    : [{ _tag: "changed", connection: current }];
}

const definitionsDiff = (
  sent: DefinitionVersions,
  current: DefinitionVersions,
): DefinitionsLiveMessage[] =>
  Equal.equals(sent, current) ? [] : [{ _tag: "changed", versions: current }];

const appearanceDiff = (sent: T3Appearance, current: T3Appearance): AppearanceLiveMessage[] =>
  Equal.equals(sent, current) ? [] : [{ _tag: "changed", appearance: current }];

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

const withoutProjectObservation = (catalog: ProjectCatalog) => ({
  ...catalog,
  projects: catalog.projects.map((project) => ({ ...project, observedAt: "" })),
});

/** The changed catalog, or only the projects whose observation time moved. */
function catalogDiff(sent: ProjectCatalog, current: ProjectCatalog) {
  if (Equal.equals(sent, current)) return {};
  if (!Equal.equals(withoutProjectObservation(sent), withoutProjectObservation(current)))
    return { catalog: current };
  const observedAt = new Map(sent.projects.map((project) => [project.id, project.observedAt]));
  return {
    observed: current.projects
      .filter((project) => observedAt.get(project.id) !== project.observedAt)
      .map(({ id, observedAt }) => ({ id, observedAt })),
  };
}

function launchChoicesDiff(
  sent: LaunchChoices,
  current: LaunchChoices,
): LaunchChoicesLiveMessage[] {
  const previous = new Map(sent.flows.map((flow) => [flow.id, flow]));
  const upserts = current.flows.filter((flow) => !Equal.equals(previous.get(flow.id), flow));
  const present = new Set(current.flows.map((flow) => flow.id));
  const removals = sent.flows.filter((flow) => !present.has(flow.id)).map((flow) => flow.id);
  const flowsChanged = upserts.length > 0 || removals.length > 0;
  const { catalog, observed } = catalogDiff(sent.catalog, current.catalog);
  const messages: LaunchChoicesLiveMessage[] = [];
  if (catalog || flowsChanged)
    messages.push({
      _tag: "changed",
      ...(catalog ? { catalog } : {}),
      ...(flowsChanged ? { flows: { upserts, removals } } : {}),
    });
  if (observed) messages.push({ _tag: "observed", projects: observed });
  return messages;
}

type RunState = RunDetail | OperationError;
type RunView = {
  readonly navigation: readonly RunNavigationEntry[] | null;
  readonly runs: ReadonlyMap<string, RunState>;
};
const isRun = (state: RunState | undefined): state is RunDetail =>
  state !== undefined && "blocks" in state;

const runSnapshot = (runId: string, state: RunState): RunViewLiveMessage =>
  isRun(state)
    ? { _tag: "run", runId, message: { _tag: "snapshot", run: state } }
    : { _tag: "missing", runId, error: state };

function viewSnapshot(view: RunView): RunViewLiveMessage[] {
  const messages: RunViewLiveMessage[] = view.navigation
    ? [{ _tag: "navigation", message: { _tag: "snapshot", rows: view.navigation } }]
    : [];
  for (const [runId, state] of view.runs) messages.push(runSnapshot(runId, state));
  return messages;
}

function viewDiff(sent: RunView, current: RunView): RunViewLiveMessage[] {
  const messages: RunViewLiveMessage[] =
    sent.navigation && current.navigation
      ? navigationDiff(sent.navigation, current.navigation).map((message) => ({
          _tag: "navigation",
          message,
        }))
      : [];
  for (const [runId, state] of current.runs) {
    const previous = sent.runs.get(runId);
    if (isRun(previous) && isRun(state))
      for (const message of runDiff(previous, state))
        messages.push({ _tag: "run", runId, message });
    else if (isRun(previous) !== isRun(state)) messages.push(runSnapshot(runId, state));
  }
  return messages;
}

export function makeLiveStreams(
  changes: LiveChanges,
  reads: {
    readonly getConnection: () => Read<T3Connection>;
    readonly listRunNavigation: () => Read<readonly RunNavigationEntry[]>;
    readonly getRun: (id: string) => Read<RunDetail>;
    readonly readProjectCatalog: () => Read<ProjectCatalog>;
    readonly listFlows: () => Read<readonly FlowDraft[]>;
    readonly readDefinitionVersions: () => Read<DefinitionVersions>;
    readonly getAppearance: () => Effect.Effect<T3Appearance>;
  },
  /** One read transaction, so a view's navigation and Runs describe the same committed state. */
  consistently: <A>(read: Effect.Effect<A, OperationError>) => Effect.Effect<A, OperationError>,
): LiveStreams {
  return {
    watchConnection: () =>
      watch(
        changes,
        { kind: "connection" },
        settled(reads.getConnection()),
        (connection) => [{ _tag: "snapshot", connection }],
        connectionDiff,
      ),
    watchRunView: ({ navigation, runIds }) => {
      const ids = [...new Set(runIds)];
      const read = consistently(
        Effect.gen(function* () {
          const rows = navigation ? yield* settled(reads.listRunNavigation()) : null;
          const runs = new Map<string, RunState>();
          for (const id of ids) {
            const result = yield* reads.getRun(id).pipe(Effect.orDie);
            if (result.ok) runs.set(id, result.value);
            else if (result.error.code === "not_found") runs.set(id, result.error);
            else return yield* Effect.fail(result.error);
          }
          return { navigation: rows, runs } satisfies RunView;
        }),
      );
      return watch(
        changes,
        { kind: "view", navigation, runIds: new Set(ids) },
        read,
        viewSnapshot,
        viewDiff,
      );
    },
    watchLaunchChoices: () =>
      watch(
        changes,
        { kind: "launchChoices" },
        consistently(
          Effect.all({
            catalog: settled(reads.readProjectCatalog()),
            flows: settled(reads.listFlows()),
          }),
        ),
        (choices) => [{ _tag: "snapshot", choices }],
        launchChoicesDiff,
      ),
    watchDefinitions: () =>
      watch(
        changes,
        { kind: "definitions" },
        settled(reads.readDefinitionVersions()),
        (versions) => [{ _tag: "snapshot", versions }],
        definitionsDiff,
      ),
    watchAppearance: () =>
      watch(
        changes,
        { kind: "appearance" },
        reads.getAppearance(),
        (appearance) => [{ _tag: "snapshot", appearance }],
        appearanceDiff,
      ),
  };
}

/** A failed read result becomes the stream's typed error. */
const settled = <A>(read: Read<A>): Effect.Effect<A, OperationError> =>
  read.pipe(
    Effect.orDie,
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
    ),
  );

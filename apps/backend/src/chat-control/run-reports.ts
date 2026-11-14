import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { channelGrants, type Destination } from "./deliveries.ts";
import { runSearch, type RunIdentity } from "./run-search.ts";
import { runOverview, type RunReadOperations } from "./run-tools.ts";

/** A chat-started Run's originating thread: where its automatic reports go. */
export interface ReportOrigin {
  readonly runId: string;
  /** The application whose confirmation started the Run; provenance, not a sending identity. */
  readonly applicationId: string;
  readonly destination: Destination;
}

type Overview = ReturnType<typeof runOverview>;

/**
 * What Factory reports about a Run, from its committed facts and the definitions it captured:
 * identity and lifecycle, Blocks, the latest accepted result of each Block with worker completion
 * and handoff release kept apart, pending Waits with deadlines, and pending attention matters
 * with their exact identities. Observation freshness is a fact of its own: a stale or unknown
 * observation is never a Problem by itself. Long texts (results, prompts, Human context) are not
 * part of a report; Read Run serves them.
 */
export interface RunReport {
  readonly run: RunIdentity;
  /** A confirmed manual settlement still in progress; the Run is Active meanwhile. */
  readonly settlement: Overview["run"]["settlement"];
  readonly blocks: readonly Pick<
    Overview["lists"]["blocks"][number],
    "blockId" | "name" | "state" | "observation"
  >[];
  readonly latestResults: readonly Omit<Overview["lists"]["latestResults"][number], "result">[];
  readonly pendingWaits: readonly Omit<Overview["lists"]["pendingWaits"][number], "message">[];
  readonly needsInput: Overview["lists"]["needsInput"];
  readonly problems: readonly Omit<Overview["lists"]["problems"][number], "detail">[];
}

/** A Run's report from its identity and current detail, as Read Run describes the same facts. */
function runReport(identity: RunIdentity, detail: Parameters<typeof runOverview>[1]): RunReport {
  const { run, lists } = runOverview(identity, detail);
  return {
    run: identity,
    settlement: run.settlement,
    blocks: lists.blocks.map(({ blockId, name, state, observation }) => ({
      blockId,
      name,
      state,
      observation,
    })),
    latestResults: lists.latestResults.map(({ result: _result, ...rest }) => rest),
    pendingWaits: lists.pendingWaits.map(({ message: _message, ...rest }) => rest),
    needsInput: lists.needsInput,
    problems: lists.problems.map(({ detail: _detail, ...rest }) => rest),
  };
}

/**
 * One kind of automatic reporting. `capture` runs inside one transaction per origin and records
 * what the origin is owed now as durable delivery obligations. `report` is undefined while the
 * origin's channel does not grant the Run's Project: nothing accrues for that scope then, and a
 * later capture after a regrant starts from the Run's current state.
 */
export interface ReportConsumer {
  readonly capture: (
    origin: ReportOrigin,
    report: RunReport | undefined,
  ) => Effect.Effect<void, unknown>;
}

type OriginRow = {
  run_id: string;
  application_id: string;
  guild_id: string;
  parent_channel_id: string;
  thread_id: string;
};

const originOf = (row: OriginRow): ReportOrigin => ({
  runId: row.run_id,
  applicationId: row.application_id,
  destination: {
    guildId: row.guild_id,
    parentChannelId: row.parent_channel_id,
    threadId: row.thread_id,
  },
});

/**
 * Captures automatic reporting obligations from committed Factory facts. Run change hints only
 * say which Runs to look at; each capture reads the Run's committed state and lets every consumer
 * record its obligations durably, so a lost hint costs nothing: startup, every regrant and every
 * serving session rescan all origins whose reporting is not final. It runs for the backend's
 * whole life, whether Chat control is On or Off and whether any client watches, and never
 * delays the Factory work it reports. `delivered` wakes delivery after each capture.
 */
export const makeReportCapture = (
  sql: SqlClient.SqlClient,
  reads: RunReadOperations,
  consumers: readonly ReportConsumer[],
  delivered: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const search = runSearch(sql);
    const changed = new Set<string>();
    let everything = true;
    let signal = yield* Deferred.make<void>();
    const notify = () => Deferred.doneUnsafe(signal, Effect.void);

    const captureOrigin = (row: OriginRow) =>
      Effect.gen(function* () {
        const granted = yield* channelGrants(sql, row.parent_channel_id);
        const identity = yield* search.reference([...granted], { id: row.run_id });
        let report: RunReport | undefined;
        if (identity) {
          const detail = yield* reads.getRun(identity.id);
          // An unreadable Run keeps what was captured before; the next change captures again.
          if (!detail.ok) return;
          report = runReport(identity, detail.value);
        }
        const origin = originOf(row);
        yield* sql.withTransaction(
          Effect.forEach(consumers, (consumer) => consumer.capture(origin, report), {
            discard: true,
          }),
        );
      }).pipe(Effect.ignore);

    /** Origins to capture now: every one not final after a rescan, otherwise the changed Runs. */
    const due = (all: boolean, runIds: readonly string[]) =>
      all
        ? sql<OriginRow>`SELECT o.* FROM chat_run_origins o JOIN runs r ON r.id=o.run_id
            LEFT JOIN chat_status_cards c ON c.run_id=o.run_id
            WHERE r.archived_at IS NULL OR c.final IS NOT 1 ORDER BY o.recorded_at`
        : sql<OriginRow>`SELECT * FROM chat_run_origins WHERE run_id IN ${sql.in(runIds)} ORDER BY recorded_at`;

    const run = Effect.gen(function* () {
      for (;;) {
        if (!everything && changed.size === 0) {
          yield* Deferred.await(signal);
          signal = yield* Deferred.make<void>();
          continue;
        }
        const all = everything;
        const runIds = [...changed];
        everything = false;
        changed.clear();
        for (const row of yield* due(all, runIds)) yield* captureOrigin(row);
        yield* delivered;
      }
    });

    return {
      /** A committed change to `runId` may change what its origin is owed. */
      changed: (runId: string) => {
        changed.add(runId);
        notify();
      },
      /** Capture every origin whose reporting is not final, as after a regrant. */
      rescan: Effect.sync(() => {
        everything = true;
        notify();
      }),
      /** The capture loop; fork it in the backend's scope once the Runner owns Runs. */
      run,
    };
  });

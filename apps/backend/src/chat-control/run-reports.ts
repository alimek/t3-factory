import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  attentionPresentation,
  awaitsReviewInT3,
  type FlowGraph,
  type RunAttention,
  type RunDetail,
} from "@t3-factory/contracts";
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

interface ReportBlock {
  readonly name: string;
  readonly kind: FlowGraph["blocks"][number]["kind"];
  readonly state: RunDetail["blocks"][number]["state"];
  readonly observation: RunDetail["blocks"][number]["freshness"];
  readonly needsInput: "T3" | "Human" | null;
  readonly problem: RunAttention["kind"] | null;
  readonly wait: { readonly deadlineAt: string; readonly count: number } | null;
}

/**
 * What Factory reports about a Run, from its committed facts and the definitions it captured:
 * identity and lifecycle, Blocks, pending Waits with deadlines, and pending attention matters
 * with their exact identities. Observation freshness is a fact of its own: a stale or unknown
 * observation is never a Problem by itself. Long texts (results, prompts, Human context) are not
 * part of a report; Read Run serves them.
 */
export interface RunReport {
  readonly run: RunIdentity;
  /** A confirmed manual settlement still in progress; the Run is Active meanwhile. */
  readonly settlement: Overview["run"]["settlement"];
  readonly blocks: readonly ReportBlock[];
  readonly needsInput: Overview["lists"]["needsInput"];
  readonly problems: readonly Omit<Overview["lists"]["problems"][number], "detail">[];
}

function groupBy<T, Key>(items: readonly T[], keyOf: (item: T) => Key) {
  const groups = new Map<Key, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function orderedBlocks(graph: FlowGraph) {
  const remaining = new Map(graph.blocks.map((block) => [block.id, block]));
  const connections = groupBy(graph.connections, (connection) => connection.sourceBlockId);
  const queue = [...graph.flowInput.targetBlockIds];
  const ordered: FlowGraph["blocks"][number][] = [];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    const block = remaining.get(id);
    if (!block) continue;
    remaining.delete(id);
    ordered.push(block);
    for (const connection of connections.get(id) ?? []) queue.push(connection.targetBlockId);
  }
  return ordered.concat(
    [...remaining.values()].sort((a, b) => {
      const position = a.position.x - b.position.x || a.position.y - b.position.y;
      if (position !== 0) return position;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    }),
  );
}

function reportBlocks(detail: RunDetail): ReportBlock[] {
  const recorded = new Map(detail.blocks.map((block) => [block.blockId, block]));
  const attention = groupBy(
    detail.attention.filter((matter) => matter.settledAt === null),
    (matter) => matter.blockId,
  );
  const waits = groupBy(
    detail.waitArrivals.filter((arrival) => arrival.state === "pending"),
    (arrival) => arrival.blockId,
  );
  return orderedBlocks(detail.definitions.flow.graph).map(({ id, name, kind }) => {
    const block = recorded.get(id);
    const pending = attention.get(id) ?? [];
    const problem = pending.find((matter) => attentionPresentation(matter.kind) === "problem");
    const needsInput = pending.filter(
      (matter) => attentionPresentation(matter.kind) === "needs-input",
    );
    const reviewInT3 = block !== undefined && awaitsReviewInT3(block);
    const wait = waits.get(id);
    return {
      name,
      kind,
      state: block?.state ?? "not-started",
      observation: block?.freshness ?? "unknown",
      problem: problem?.kind ?? null,
      needsInput:
        detail.settlement !== null
          ? null
          : reviewInT3 || needsInput.some((matter) => matter.kind === "native-request")
            ? "T3"
            : needsInput.length > 0
              ? "Human"
              : null,
      wait: wait
        ? {
            deadlineAt: wait.reduce(
              (earliest, arrival) =>
                arrival.deadlineAt < earliest ? arrival.deadlineAt : earliest,
              wait[0]!.deadlineAt,
            ),
            count: wait.length,
          }
        : null,
    };
  });
}

/** A Run's report from its identity and current detail, as Read Run describes the same facts. */
function runReport(identity: RunIdentity, detail: Parameters<typeof runOverview>[1]): RunReport {
  const { run, lists } = runOverview(identity, detail);
  return {
    run: identity,
    settlement: run.settlement,
    blocks: reportBlocks(detail),
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
            LEFT JOIN chat_run_reporting n ON n.run_id=o.run_id
            WHERE r.archived_at IS NULL OR c.final IS NOT 1 OR n.final IS NOT 1 ORDER BY o.recorded_at`
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

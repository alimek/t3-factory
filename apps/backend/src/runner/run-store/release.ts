import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunRow } from "../runner-types.ts";
import { now } from "../../time.ts";
import { guardsHold } from "./guards.ts";
import type { RunnerDatabase } from "./database.ts";
import { appendTimelineEvent } from "./steps.ts";

/** Where a Handoff comes from: a Final result version, or else a Human occurrence's answer. */
type HandoffSource = {
  readonly report_id: string | null;
  readonly occurrence_id: string | null;
  readonly source_block_id: string | null;
};

/** A Human answer releases the Handoffs it creates. */
function humanAnswered(sql: SqlClient.SqlClient, runId: string, source: HandoffSource) {
  return Effect.map(
    sql`SELECT id FROM human_occurrences WHERE id=${source.occurrence_id} AND run_id=${runId} AND block_id=${source.source_block_id} AND state='answered'`,
    (rows) => rows.length > 0,
  );
}

/** A Final result version is released once its release record exists under the Run's context. */
function resultReleased(sql: SqlClient.SqlClient, contextId: string, reportId: string) {
  return Effect.map(
    sql`SELECT report_id FROM result_releases WHERE report_id=${reportId} AND context_id=${contextId}`,
    (rows) => rows.length > 0,
  );
}

/** Whether a Handoff's source is released, as the Run's records show it now. */
export function handoffReleased(
  sql: SqlClient.SqlClient,
  run: Pick<RunRow, "id" | "context_id">,
  source: HandoffSource,
) {
  return source.report_id
    ? resultReleased(sql, run.context_id, source.report_id)
    : humanAnswered(sql, run.id, source);
}

/** A Final result version's Block worker thread, and whether the version is still its
 * activation's newest Final result; undefined when the version does not exist. */
function releaseSource(sql: SqlClient.SqlClient, reportId: string) {
  return Effect.map(
    sql<{
      current: number;
      thread_id: string | null;
    }>`SELECT r.id=(SELECT n.id FROM runtime_reports n WHERE n.activation_id=r.activation_id AND n.status='finished' ORDER BY n.rowid DESC LIMIT 1) AS current,b.thread_id FROM runtime_reports r JOIN run_blocks b ON b.run_id=r.run_id AND b.block_id=r.block_id WHERE r.id=${reportId}`,
    ([source]) => source,
  );
}

/** What releasing a Final result version still waits for. */
type ReleaseWait =
  | { readonly released: true }
  /** Its source worker thread being finished; null when the version cannot be released now
   * because its Block has no worker thread yet or a newer version replaced it. */
  | { readonly released: false; readonly sourceThreadId: string | null };

/**
 * The local part of the Handoff release rule. Orchestration asks it before a held Handoff becomes
 * a delivery and again when a delivery from a Final result is reserved, reading in between
 * whether the source worker thread is finished in T3.
 */
export function openRunRelease(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** What releasing Final result version `reportId` waits for, under `run`'s authorization context. */
  const releaseWait = (run: RunRow, reportId: string) =>
    database.transaction((sql) =>
      Effect.gen(function* (): Effect.fn.Return<ReleaseWait, unknown> {
        const source = yield* releaseSource(sql, reportId);
        if (!source?.thread_id) return { released: false, sourceThreadId: null };
        if (yield* resultReleased(sql, run.context_id, reportId)) return { released: true };
        return { released: false, sourceThreadId: source.current ? source.thread_id : null };
      }),
    );

  /** Releases Final result version `reportId` once; the caller read its source worker thread
   * finished at `run`, the snapshot the release is stamped with. Guards: owner, not Archived, live
   * authorization context, open gate and `run`'s generation (a report accepted since may have
   * replaced the version); the version is still its activation's newest Final result and no
   * execution failure is pending on the Block. It records the release, marks the version
   * completion-eligible and appends "Handoff released" for each of its Handoffs, and does not
   * advance the generation. Answers whether this call released it. */
  function releaseFinalResult(run: RunRow, reportId: string) {
    return database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, run.id, {
          owner: true,
          notArchived: true,
          liveContext: run.context_id,
          gateOpen: true,
          generation: run.generation,
        });
        if (!held) return false;
        if (!(yield* releaseSource(sql, reportId))?.current) return false;
        const failed =
          yield* sql`SELECT a.id FROM run_attention a JOIN runtime_reports r ON r.run_id=a.run_id AND r.block_id=a.block_id WHERE r.id=${reportId} AND a.kind='execution-failed' AND a.settled_at IS NULL`;
        if (failed.length) return false;
        const time = yield* now;
        const rows =
          yield* sql`INSERT INTO result_releases(report_id,activation_id,generation,context_id,released_at) SELECT id,activation_id,${run.generation},${run.context_id},${time} FROM runtime_reports WHERE id=${reportId} ON CONFLICT DO NOTHING RETURNING report_id`;
        if (!rows.length) return false;
        yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE id=${reportId}`;
        const handoffs = yield* sql<{
          id: string;
          block_id: string;
        }>`SELECT id,block_id FROM operation_intents WHERE report_id=${reportId} ORDER BY rowid`;
        for (const handoff of handoffs)
          yield* appendTimelineEvent(sql, {
            kind: "handoff-released",
            runId: run.id,
            blockId: handoff.block_id,
            intentId: handoff.id,
            observedAt: time,
          });
        return true;
      }),
    );
  }

  /** Whether the Human occurrence behind a delivery is answered, read before it is reserved. */
  const humanSourceAnswered = (runId: string, source: HandoffSource) =>
    database.transaction((sql) => humanAnswered(sql, runId, source));

  return { releaseWait, releaseFinalResult, humanSourceAnswered };
}

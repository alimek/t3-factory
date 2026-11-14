import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunRow } from "../runner-types.ts";
import { now } from "../../time.ts";
import { currentReports } from "./current-report.ts";
import { guardsHold } from "./guards.ts";
import { clearSnooze } from "./presentation.ts";
import { settleReportRejections } from "./report-diagnostics.ts";
import type { RunnerDatabase } from "./database.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** Settled leaves the main navigation and clears Snooze. */
export function markSettled(
  sql: SqlClient.SqlClient,
  runId: string,
  cause: "automatic" | "manual",
  time: string,
) {
  return Effect.gen(function* () {
    yield* sql`UPDATE runs SET settled_at=${time} WHERE id=${runId}`;
    yield* clearSnooze(sql, runId);
    yield* appendTimelineEvent(sql, { kind: "run-settled", runId, cause, observedAt: time });
  });
}

/** Any accepted report from a Block of a Settled Run returns the Run to Active, advancing its
 * generation. */
export function returnToActive(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  reportId: string | undefined,
) {
  return Effect.gen(function* () {
    const changed =
      yield* sql`UPDATE runs SET settled_at=NULL WHERE id=${runId} AND settled_at IS NOT NULL RETURNING id`;
    if (!changed.length) return;
    yield* advanceGeneration(sql, runId);
    yield* appendTimelineEvent(sql, {
      kind: "run-activated",
      runId,
      blockId,
      ...(reportId === undefined ? {} : { reportId }),
      observedAt: yield* now,
    });
  });
}

/** The worker thread of a Block whose current result's T3 run has not been claimed yet. */
type ThreadSettlementCandidate = {
  readonly report_id: string;
  readonly thread_id: string;
  readonly execution_id: string;
};

/** An Agent Block owns its worker thread; a Continuation's prompt runs on the thread its visit is
 * bound to, so its result settles that thread for the prompt's T3 run. */
function finishedBlockCandidates(sql: SqlClient.SqlClient, runId: string) {
  return sql<ThreadSettlementCandidate>`SELECT c.report_id,c.thread_id,c.execution_id FROM (SELECT r.id AS report_id,COALESCE(b.thread_id,pt.thread_id) AS thread_id,r.execution_id,b.run_id,b.block_id,b.rowid AS block_order FROM run_blocks b JOIN run_activations a ON a.run_id=b.run_id AND a.block_id=b.block_id AND a.rowid=(SELECT MAX(l.rowid) FROM run_activations l WHERE l.run_id=b.run_id AND l.block_id=b.block_id) LEFT JOIN continuation_visits pv ON pv.activation_id=a.id LEFT JOIN run_thread_bindings pt ON pt.id=pv.binding_id LEFT JOIN working_reports w ON w.activation_id=a.id AND w.replaced_at IS NULL JOIN runtime_reports r ON r.activation_id=a.id AND r.status='finished' AND r.rowid=(SELECT MAX(n.rowid) FROM runtime_reports n WHERE n.activation_id=a.id AND n.status='finished') WHERE b.run_id=${runId} AND w.id IS NULL AND r.execution_id IS NOT NULL) c WHERE c.thread_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs WHERE id=c.run_id AND block_settlement_enabled=1) AND NOT EXISTS(SELECT 1 FROM t3_thread_settlements s WHERE s.run_id=c.run_id AND s.thread_id=c.thread_id AND s.execution_id=c.execution_id) AND NOT EXISTS(SELECT 1 FROM run_attention a2 WHERE a2.run_id=c.run_id AND a2.block_id=c.block_id AND a2.kind IN('execution-failed','missing-report') AND a2.settled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM continuation_visits v JOIN run_thread_bindings t ON t.id=v.binding_id WHERE v.run_id=c.run_id AND t.thread_id=c.thread_id AND v.kind='prompt' AND v.state='sent') ORDER BY c.block_order`;
}

export function openRunSettlement(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** Every visited Block's current report is its finished result and no attention is pending:
   * the worker threads automatic settlement must find finished, or null. */
  function reportedBlockThreads(runId: string) {
    return database.transaction((sql) =>
      Effect.gen(function* () {
        const blocks = yield* sql<{
          block_id: string;
          thread_id: string;
        }>`SELECT block_id,thread_id FROM run_blocks WHERE run_id=${runId} AND thread_id IS NOT NULL ORDER BY rowid`;
        const current = new Map(
          (yield* currentReports(sql, runId)).map((entry) => [entry.blockId, entry.report?.status]),
        );
        // A Continuation whose prompt is out owes its response, also once its worker's Block
        // reported.
        const pending =
          yield* sql`SELECT id FROM run_attention WHERE run_id=${runId} AND settled_at IS NULL UNION ALL SELECT id FROM continuation_visits WHERE run_id=${runId} AND state IN ('sent','queued')`;
        const done =
          blocks.length > 0 &&
          !pending.length &&
          blocks.every((b) => current.get(b.block_id) === "finished");
        return done ? blocks.map((b) => b.thread_id) : null;
      }),
    );
  }

  /** Automatic settlement of `run`, the snapshot whose worker threads the caller read finished.
   * Guards: owner, not Archived, live authorization context, open gate and the snapshot's
   * generation; the Run must still be Active and owe nothing. It does not advance the generation. */
  function settleAutomatically(run: RunRow) {
    const id = run.id;
    return database.mutate(id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, id, {
          owner: true,
          notArchived: true,
          liveContext: run.context_id,
          gateOpen: true,
          generation: run.generation,
        });
        if (!held) return false;
        const [current] = yield* sql<{
          settled_at: string | null;
        }>`SELECT settled_at FROM runs WHERE id=${id}`;
        if (current?.settled_at) return false;
        // A replaced result's held handoffs are cancelled and owe no delivery, nor do idle-worker
        // preparations Runs made before Factory stopped preparing them. A rejected launch is
        // cancelled too, but its Block has no result. An unbound worktree still owes the launches
        // that join it, and a pending Wait arrival still owes its forwarding.
        const pending =
          yield* sql`SELECT id FROM operation_intents WHERE run_id=${id} AND state!='acknowledged' AND NOT (state='cancelled' AND kind IN ('handoff','prepare')) UNION ALL SELECT id FROM human_occurrences WHERE run_id=${id} AND state!='answered' UNION ALL SELECT id FROM wait_arrivals WHERE run_id=${id} AND state='pending' UNION ALL SELECT run_id FROM run_workspaces WHERE run_id=${id} AND state='preparing' UNION ALL SELECT id FROM continuation_visits WHERE run_id=${id} AND state IN ('sent','queued')`;
        if (pending.length) return false;
        const time = yield* now;
        yield* markSettled(sql, id, "automatic", time);
        yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE run_id=${id}`;
        // Terminal activations have no handoff release to settle their recovery diagnostics.
        const reports = yield* sql<{
          block_id: string;
        }>`SELECT DISTINCT block_id FROM runtime_reports WHERE run_id=${id}`;
        for (const report of reports) yield* settleReportRejections(sql, id, report.block_id, time);
        return true;
      }),
    );
  }

  const threadSettlementCandidates = (runId: string) =>
    database.transaction((sql) => finishedBlockCandidates(sql, runId));

  /** Claims the T3 run that produced a Block's result before native settlement is requested.
   * Guards: owner, not Archived, live authorization context and the generation of `run`, the
   * snapshot the caller read the worker thread at; the candidate must still be unclaimed. It does
   * not advance the generation. */
  function claimBlockThreadSettlement(run: RunRow, candidate: ThreadSettlementCandidate) {
    return database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, run.id, {
          owner: true,
          notArchived: true,
          liveContext: run.context_id,
          generation: run.generation,
        });
        if (!held) return false;
        const candidates = yield* finishedBlockCandidates(sql, run.id);
        if (!candidates.some((current) => current.report_id === candidate.report_id)) return false;
        const rows =
          yield* sql`INSERT INTO t3_thread_settlements(run_id,thread_id,execution_id,attempted_at) SELECT ${run.id},${candidate.thread_id},${candidate.execution_id},${yield* now} FROM runs WHERE id=${run.id} AND archived_at IS NULL ON CONFLICT DO NOTHING RETURNING thread_id`;
        return rows.length > 0;
      }),
    );
  }

  /** The bound worker threads of a Settled Run and the T3 run each was last bound at. */
  const settledRunThreads = (runId: string) =>
    database.transaction(
      (sql) =>
        sql<{
          thread_id: string;
          execution_id: string;
        }>`SELECT b.thread_id,b.execution_id FROM run_blocks b JOIN run_executions x ON x.run_id=b.run_id AND x.thread_id=b.thread_id AND x.execution_id=b.execution_id WHERE b.run_id=${runId} ORDER BY b.rowid`,
    );

  /** Claims a T3 run of a Settled Run's worker thread before native settlement is requested.
   * Guards: owner, not Archived and live authorization context; the Run must be Settled. No
   * generation is compared or advanced. */
  function claimSettledRunThreadSettlement(run: RunRow, threadId: string, executionId: string) {
    return database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, run.id, {
          owner: true,
          notArchived: true,
          liveContext: run.context_id,
        });
        if (!held) return false;
        const rows =
          yield* sql`INSERT INTO t3_thread_settlements(run_id,thread_id,execution_id,attempted_at) SELECT ${run.id},${threadId},${executionId},${yield* now} FROM runs WHERE id=${run.id} AND settled_at IS NOT NULL ON CONFLICT DO NOTHING RETURNING thread_id`;
        return rows.length > 0;
      }),
    );
  }

  return {
    reportedBlockThreads,
    settleAutomatically,
    threadSettlementCandidates,
    claimBlockThreadSettlement,
    settledRunThreads,
    claimSettledRunThreadSettlement,
  };
}

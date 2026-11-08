import { settleReportRejections } from "./runner-report-diagnostics.ts";
import { currentReports } from "./block-report.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { newId } from "./ids.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { changeLifecycle } from "./run-lifecycle.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { recoverOperation } from "./runner-effects.ts";
import { runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";
import { readWorkerThread } from "./worker-thread.ts";

const UNUSED_PREPARATION =
  "The Run settled before this Block was visited, so Factory stopped preparing its idle worker.";

/** Settled leaves the main navigation and clears Snooze; execution and attention are unchanged. */
function markSettled(
  sql: SqlClient.SqlClient,
  runId: string,
  cause: "automatic" | "manual",
  time: string,
) {
  return Effect.gen(function* () {
    yield* sql`UPDATE runs SET settled_at=${time} WHERE id=${runId}`;
    yield* sql`UPDATE run_presentation SET snoozed=0,woke=0 WHERE run_id=${runId}`;
    yield* sql`INSERT INTO run_events(run_id,kind,source_key,cause_id,observed_at) VALUES(${runId},'run-settled',${"settled:" + (yield* newId)},${cause},${time})`;
  });
}

/** Any accepted report from a Block of a Settled Run returns the Run to Active. */
export function returnToActive(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  reportId: string | undefined,
) {
  return Effect.gen(function* () {
    const changed =
      yield* sql`UPDATE runs SET settled_at=NULL,generation=generation+1 WHERE id=${runId} AND settled_at IS NOT NULL RETURNING id`;
    if (changed.length)
      yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runId},${blockId},'run-activated',${"activated:" + (yield* newId)},${reportId ?? null},${yield* now})`;
  });
}

export function openRunnerSettle(
  database: RunnerDatabase,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  /** Every visited Block's current report is its finished result, and no attention is pending. */
  function reportedBlocks(run: RunRow) {
    return database.transaction((sql) =>
      Effect.gen(function* () {
        const blocks = yield* sql<{
          block_id: string;
          thread_id: string;
        }>`SELECT block_id,thread_id FROM run_blocks WHERE run_id=${run.id} AND thread_id IS NOT NULL ORDER BY rowid`;
        const current = new Map(
          (yield* currentReports(sql, run.id)).map((entry) => [
            entry.blockId,
            entry.report?.status,
          ]),
        );
        const pending =
          yield* sql`SELECT id FROM run_attention WHERE run_id=${run.id} AND settled_at IS NULL`;
        const done =
          blocks.length > 0 &&
          !pending.length &&
          blocks.every((b) => current.get(b.block_id) === "finished");
        return done ? blocks.map((b) => b.thread_id) : null;
      }),
    );
  }

  /** A worker thread T3 cannot read now keeps the Run Active until a later sweep. */
  function threadsFinished(run: RunRow, threads: readonly string[]) {
    return recoverOperation(
      Effect.gen(function* () {
        for (const thread of threads)
          if (!(yield* Effect.tryPromise(() => readWorkerThread(t3, run, thread))).finished)
            return false;
        return true;
      }),
      () => Effect.succeed(false),
    );
  }

  /** Automatic settlement: every visited Block has its result, nothing is pending locally, no Human
   * occurrence is open and a fresh read finds every worker thread finished. */
  function settleWhenDone(id: string) {
    return Effect.gen(function* () {
      const run = yield* database.row(id);
      if (!run || run.archived_at || run.settled_at || !run.gate_open) return;
      const threads = yield* reportedBlocks(run);
      if (!threads || !(yield* threadsFinished(run, threads))) return;
      if ((yield* liveContextId()) !== run.context_id) return;
      const settled = yield* database.mutate(id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
          const [current] = yield* sql<{
            generation: number;
            settled_at: string | null;
          }>`SELECT generation,settled_at FROM runs WHERE id=${id}`;
          if (current?.generation !== run.generation || current.settled_at) return false;
          // A replaced result's held handoffs are cancelled and owe no delivery. An idle worker
          // owes nothing: an arrival for its Block is an unresolved intent of its own. An unbound
          // worktree still owes the launches that join it.
          const pending =
            yield* sql`SELECT id FROM operation_intents WHERE run_id=${id} AND kind!='prepare' AND state!='acknowledged' AND NOT (kind='handoff' AND state='cancelled') UNION ALL SELECT id FROM human_occurrences WHERE run_id=${id} AND state!='answered' UNION ALL SELECT run_id FROM run_workspaces WHERE run_id=${id} AND state='preparing'`;
          if (pending.length) return false;
          const time = yield* now;
          // An uncertain idle launch is abandoned, never resent; a later arrival launches instead.
          yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem=${UNUSED_PREPARATION},reconciled_at=${time} WHERE run_id=${id} AND kind='prepare' AND state IN ('pending','reserved','uncertain')`;
          yield* markSettled(sql, id, "automatic", time);
          yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE run_id=${id}`;
          // Terminal activations have no handoff release to settle their recovery diagnostics.
          const reports = yield* sql<{
            block_id: string;
          }>`SELECT DISTINCT block_id FROM runtime_reports WHERE run_id=${id}`;
          for (const report of reports)
            yield* settleReportRejections(sql, id, report.block_id, time);
          return true;
        }),
      );
      if (settled) yield* settleWorkerThreads(run);
    });
  }

  const finishedBlockCandidates = (sql: SqlClient.SqlClient, runId: string) =>
    sql<{
      report_id: string;
      thread_id: string;
      execution_id: string;
    }>`SELECT r.id AS report_id,b.thread_id,r.execution_id FROM run_blocks b JOIN run_activations a ON a.run_id=b.run_id AND a.block_id=b.block_id AND a.rowid=(SELECT MAX(l.rowid) FROM run_activations l WHERE l.run_id=b.run_id AND l.block_id=b.block_id) LEFT JOIN working_reports w ON w.activation_id=a.id AND w.replaced_at IS NULL JOIN runtime_reports r ON r.activation_id=a.id AND r.status='finished' AND r.rowid=(SELECT MAX(n.rowid) FROM runtime_reports n WHERE n.activation_id=a.id AND n.status='finished') WHERE b.run_id=${runId} AND EXISTS(SELECT 1 FROM runs WHERE id=b.run_id AND block_settlement_enabled=1) AND b.thread_id IS NOT NULL AND w.id IS NULL AND r.execution_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM coordinator_settlements s WHERE s.run_id=b.run_id AND s.thread_id=b.thread_id AND s.execution_id=r.execution_id) AND NOT EXISTS(SELECT 1 FROM run_attention a2 WHERE a2.run_id=b.run_id AND a2.block_id=b.block_id AND a2.kind IN('execution-failed','missing-report') AND a2.settled_at IS NULL) ORDER BY b.rowid`;

  /** Claims one T3 run of a worker thread and issues native settlement when allowed. */
  function claimWorkerThreadSettlement(
    run: RunRow,
    threadId: string,
    executionId: string,
    reportId: string | null,
  ) {
    return Effect.gen(function* () {
      if ((yield* liveContextId()) !== run.context_id) return;
      const claimed = yield* database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return false;
          if (reportId !== null) {
            const [current] =
              yield* sql`SELECT id FROM runs WHERE id=${run.id} AND generation=${run.generation}`;
            if (!current) return false;
            const candidates = yield* finishedBlockCandidates(sql, run.id);
            if (!candidates.some((candidate) => candidate.report_id === reportId)) return false;
          }
          const rows = yield* reportId === null
            ? sql`INSERT INTO coordinator_settlements(run_id,thread_id,execution_id,attempted_at) SELECT ${run.id},${threadId},${executionId},${yield* now} FROM runs WHERE id=${run.id} AND settled_at IS NOT NULL ON CONFLICT DO NOTHING RETURNING thread_id`
            : sql`INSERT INTO coordinator_settlements(run_id,thread_id,execution_id,attempted_at) SELECT ${run.id},${threadId},${executionId},${yield* now} FROM runs WHERE id=${run.id} AND archived_at IS NULL ON CONFLICT DO NOTHING RETURNING thread_id`;
          return rows.length > 0;
        }),
      );
      if (!claimed) return;
      yield* recoverOperation(
        Effect.tryPromise(() => t3.settleThread(runTarget(run), { threadId })),
        () => Effect.void,
      );
    });
  }

  /** Settles worker threads whose Blocks already have a confirmed finished result while the Run continues. */
  function settleFinishedBlockThreads(id: string) {
    return Effect.gen(function* () {
      const run = yield* database.row(id);
      if (!run || run.archived_at) return;
      const support = yield* Effect.tryPromise(() =>
        t3.inspectSettleSupport(runTarget(run)).catch(() => null),
      );
      if (!support?.supported) return;
      const candidates = yield* database.transaction((sql) => finishedBlockCandidates(sql, run.id));
      for (const candidate of candidates) {
        const ready = yield* recoverOperation(
          Effect.tryPromise(async () => {
            const worker = await readWorkerThread(t3, run, candidate.thread_id);
            return worker.finished && worker.latest?.runId === candidate.execution_id;
          }),
          () => Effect.succeed(false),
        );
        if (!ready) continue;
        yield* claimWorkerThreadSettlement(
          run,
          candidate.thread_id,
          candidate.execution_id,
          candidate.report_id,
        );
      }
    });
  }

  /** Best-effort native organization of a Settled Run's worker threads. A possibly issued
   * settlement is never replayed for the same run of a thread, so a manual reopen in T3 is
   * preserved; Factory never unsettles. */
  function settleWorkerThreads(run: RunRow) {
    return Effect.gen(function* () {
      const support = yield* Effect.tryPromise(() =>
        t3.inspectSettleSupport(runTarget(run)).catch(() => null),
      );
      if (!support?.supported) return;
      const threads = yield* database.transaction(
        (sql) =>
          sql<{
            thread_id: string;
            execution_id: string;
          }>`SELECT b.thread_id,b.execution_id FROM run_blocks b JOIN run_executions x ON x.run_id=b.run_id AND x.thread_id=b.thread_id AND x.execution_id=b.execution_id WHERE b.run_id=${run.id} ORDER BY b.rowid`,
      );
      for (const thread of threads)
        yield* claimWorkerThreadSettlement(run, thread.thread_id, thread.execution_id, null);
    });
  }

  /** The user settles an Active or Snoozed Run at any time. Work already in progress continues;
   * Factory settles the worker threads in T3 in the background. */
  function settleRun(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    return changeLifecycle(
      database,
      lifecycle,
      id,
      (sql, run) =>
        Effect.gen(function* () {
          if (run.archived_at) return failure("conflict", "An archived Run cannot be settled.");
          if (!run.settled_at) yield* markSettled(sql, id, "manual", yield* now);
          return { ok: true as const, value: !run.settled_at };
        }),
      recoverOperation(
        Effect.flatMap(database.row(id), (run) => (run ? settleWorkerThreads(run) : Effect.void)),
        () => Effect.void,
      ),
    );
  }

  return { settleRun, settleWhenDone, settleFinishedBlockThreads };
}

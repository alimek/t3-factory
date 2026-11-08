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
          // A replaced result's held handoffs are cancelled and owe no delivery, and a rejected
          // idle worker owes nothing. An unbound worktree still owes the launches that join it.
          const pending =
            yield* sql`SELECT id FROM operation_intents WHERE run_id=${id} AND state!='acknowledged' AND NOT (kind IN ('handoff','prepare') AND state='cancelled') UNION ALL SELECT id FROM human_occurrences WHERE run_id=${id} AND state!='answered' UNION ALL SELECT run_id FROM run_workspaces WHERE run_id=${id} AND state='preparing'`;
          if (pending.length) return false;
          const time = yield* now;
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
      for (const thread of threads) {
        if ((yield* liveContextId()) !== run.context_id) return;
        const claimed = yield* database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, run))) return false;
            const rows =
              yield* sql`INSERT INTO coordinator_settlements(run_id,thread_id,execution_id,attempted_at) SELECT ${run.id},${thread.thread_id},${thread.execution_id},${yield* now} FROM runs WHERE id=${run.id} AND settled_at IS NOT NULL ON CONFLICT DO NOTHING RETURNING thread_id`;
            return rows.length > 0;
          }),
        );
        if (claimed)
          yield* recoverOperation(
            Effect.tryPromise(() =>
              t3.settleThread(runTarget(run), { threadId: thread.thread_id }),
            ),
            () => Effect.void,
          );
      }
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

  return { settleRun, settleWhenDone };
}

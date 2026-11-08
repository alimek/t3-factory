import { settleReportRejections } from "./runner-report-diagnostics.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { newId } from "./ids.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
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
  /** Every visited Block's current activation has a finished result that no later working report
   * replaced, and no attention is pending. */
  function reportedBlocks(run: RunRow) {
    return database.transaction((sql) =>
      Effect.gen(function* () {
        const blocks = yield* sql<{
          thread_id: string;
          reported: number;
          working: number;
        }>`SELECT b.thread_id,EXISTS(SELECT 1 FROM runtime_reports r WHERE r.activation_id=a.id AND r.status='finished') AS reported,EXISTS(SELECT 1 FROM working_reports w WHERE w.activation_id=a.id AND w.replaced_at IS NULL) AS working FROM run_blocks b LEFT JOIN run_activations a ON a.id=(SELECT id FROM run_activations WHERE run_id=b.run_id AND block_id=b.block_id ORDER BY rowid DESC LIMIT 1) WHERE b.run_id=${run.id} AND b.thread_id IS NOT NULL ORDER BY b.rowid`;
        const pending =
          yield* sql`SELECT id FROM run_attention WHERE run_id=${run.id} AND settled_at IS NULL`;
        const done =
          blocks.length > 0 && !pending.length && blocks.every((b) => b.reported && !b.working);
        return done ? blocks.map((b) => b.thread_id) : null;
      }),
    );
  }

  /** Automatic settlement: every visited Block has its result, nothing is pending locally, no Human
   * occurrence is open and a fresh read finds every worker thread finished. */
  function settleWhenDone(id: string) {
    return recoverOperation(
      Effect.gen(function* () {
        const run = yield* database.row(id);
        if (!run || run.closed_at || run.settled_at || !run.gate_open) return;
        const threads = yield* reportedBlocks(run);
        if (!threads) return;
        for (const thread of threads)
          if (!(yield* Effect.tryPromise(() => readWorkerThread(t3, run, thread))).finished) return;
        if ((yield* liveContextId()) !== run.context_id) return;
        const settled = yield* database.mutate(id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
            const [current] = yield* sql<{
              generation: number;
              settled_at: string | null;
            }>`SELECT generation,settled_at FROM runs WHERE id=${id}`;
            if (current?.generation !== run.generation || current.settled_at) return false;
            // A replaced result's held handoffs are cancelled and owe no delivery.
            const pending =
              yield* sql`SELECT id FROM operation_intents WHERE run_id=${id} AND state!='acknowledged' AND NOT (kind='handoff' AND state='cancelled') UNION ALL SELECT id FROM human_occurrences WHERE run_id=${id} AND state!='answered'`;
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
      }),
      () => Effect.void,
    );
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
    return Effect.gen(function* () {
      if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
      const accepted = yield* database.mutate(id, (sql) =>
        Effect.gen(function* () {
          const [run] = yield* sql<{
            closed_at: string | null;
            stop_requested_at: string | null;
            settled_at: string | null;
          }>`SELECT closed_at,stop_requested_at,settled_at FROM runs WHERE id=${id}`;
          if (!run) return failure("not_found", "This Run does not exist.");
          if (run.closed_at || run.stop_requested_at)
            return failure("conflict", "A stopped Run cannot be settled.");
          if (!run.settled_at) yield* markSettled(sql, id, "manual", yield* now);
          return { ok: true as const, value: !run.settled_at };
        }),
      );
      if (!accepted.ok) return accepted;
      const run = yield* database.row(id);
      if (accepted.value && run)
        yield* lifecycle.fork(recoverOperation(settleWorkerThreads(run), () => Effect.void));
      return yield* lifecycle.getRun(id);
    });
  }

  return { settleRun, settleWhenDone };
}

import { recoverOperation } from "./runner-effects.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { changeLifecycle } from "./run-lifecycle.ts";
import type { HumanRow, IntentRow, RunnerLifecycle } from "./runner-types.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";

/** Nothing unsent leaves an archived Run: pending launches, handoffs and Human occurrences are
 * cancelled without inventing answers, pending attention settles and unfinished activated
 * Blocks show stopped. In-flight or uncertain operations keep their recorded state. */
function cancelUnsentWork(sql: SqlClient.SqlClient, id: string, time: string) {
  return Effect.gen(function* () {
    const pending =
      yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${id} AND state='pending'`;
    for (const intent of pending) {
      yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem='cancelled-on-Archive',reconciled_at=${time} WHERE id=${intent.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${id},${intent.block_id},'operation-cancelled',${"cancelled:" + intent.id},${intent.id},${time})`;
    }
    yield* sql`UPDATE runtime_reports SET pending_message=NULL WHERE run_id=${id}`;
    const humans =
      yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE run_id=${id} AND state='pending'`;
    for (const occurrence of humans) {
      yield* sql`UPDATE human_occurrences SET state='cancelled',pending_context=NULL,settled_at=${time} WHERE id=${occurrence.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${id},${occurrence.block_id},'human-cancelled',${"human-cancelled:" + occurrence.id},${occurrence.id},${time})`;
    }
    const attention = yield* sql<{
      id: string;
      block_id: string;
      execution_id: string;
    }>`SELECT id,block_id,execution_id FROM run_attention WHERE run_id=${id} AND settled_at IS NULL`;
    for (const matter of attention) {
      yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='archived' WHERE id=${matter.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${id},${matter.block_id},${matter.execution_id},'attention-settled',${"attention-settled:" + matter.id},${matter.id},${time})`;
    }
    yield* sql`UPDATE run_blocks SET state=CASE WHEN state IN ('not-started','finished') THEN state ELSE 'stopped' END,problem=NULL WHERE run_id=${id}`;
  });
}

export function openRunnerArchive(
  database: RunnerDatabase,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  /** One best-effort interrupt per worker thread, sent once after Archive; T3 stops the thread
   * and its delegated work. Factory neither waits for nor confirms termination. */
  function interruptWorkerThreads(id: string) {
    return recoverOperation(
      Effect.gen(function* () {
        const run = yield* database.row(id);
        if (!run || (yield* liveContextId()) !== run.context_id) return;
        const threads = yield* database.transaction(
          (sql) =>
            sql<{
              thread_id: string;
            }>`SELECT thread_id FROM run_blocks WHERE run_id=${id} AND thread_id IS NOT NULL ORDER BY rowid`,
        );
        if (!threads.length) return;
        const support = yield* Effect.tryPromise(() => t3.inspectStopSupport(runTarget(run)));
        if (!support.supported) return;
        for (const { thread_id: threadId } of threads)
          yield* recoverOperation(
            Effect.tryPromise(() =>
              t3.stopThread(runTarget(run), {
                threadId,
                clientRequestId: fingerprint(`${id}:archive:${threadId}`),
              }),
            ),
            () => Effect.void,
          );
      }),
      () => Effect.void,
    );
  }

  /** Archive is final and completes in the acceptance lane; interruption follows in the background. */
  function archiveRun(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    return changeLifecycle(
      database,
      lifecycle,
      id,
      (sql, run) =>
        Effect.gen(function* () {
          if (run.archived_at) return { ok: true as const, value: false };
          const owned =
            yield* sql`SELECT token FROM runner_owner WHERE token=${database.owner.token}`;
          if (!owned.length) return failure("conflict", "Runner ownership changed.");
          const time = yield* now;
          yield* sql`UPDATE runs SET gate_open=0,archived_at=${time},generation=generation+1 WHERE id=${id}`;
          yield* cancelUnsentWork(sql, id, time);
          yield* sql`UPDATE run_presentation SET snoozed=0,woke=0 WHERE run_id=${id}`;
          yield* sql`INSERT INTO run_events(run_id,kind,source_key,observed_at) VALUES(${id},'run-archived','archived',${time})`;
          return { ok: true as const, value: true };
        }),
      interruptWorkerThreads(id),
    );
  }
  return { archiveRun };
}

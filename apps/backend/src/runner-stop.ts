import { confirmClosure, observeWorkers } from "./runner-closure.ts";
import { recoverOperation } from "./runner-effects.ts";
import { newId } from "./ids.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { HumanRow, IntentRow, RunnerLifecycle, RunRow } from "./runner-types.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";
export function openRunnerStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
) {
  const { mutate } = database;
  const owner = database.owner.token;
  const { isClosed, drive, getRun } = lifecycle;
  /** Gate closure shares the acceptance lane, never waits for remote dispatch. */
  function stopRun(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (isClosed()) return failure("conflict", "Factory is shutting down.");
      const accepted = yield* mutate(id, (sql) =>
        Effect.gen(function* () {
          const [runRow] = yield* sql<RunRow>`SELECT * FROM runs WHERE id=${id}`;
          if (!runRow) return failure("not_found", "This Run does not exist.");
          if (runRow.closed_at || runRow.stop_requested_at)
            return { ok: true as const, value: undefined };
          const owned = yield* sql`SELECT token FROM runner_owner WHERE token=${owner}`;
          if (!owned.length) return failure("conflict", "Runner ownership changed.");
          const time = yield* now;
          yield* sql`UPDATE runs SET gate_open=0,stop_requested_at=${time},generation=generation+1 WHERE id=${id}`;
          const pending =
            yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${id} AND state='pending'`;
          for (const intent of pending) {
            yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem='cancelled-on-Stop',reconciled_at=${time} WHERE id=${intent.id}`;
            yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${id},${intent.block_id},'operation-cancelled',${"cancelled:" + intent.id},${intent.id},${time})`;
          }
          yield* sql`UPDATE runtime_reports SET pending_message=NULL WHERE run_id=${id}`;
          const humans =
            yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE run_id=${id} AND state='pending'`;
          for (const occurrence of humans) {
            yield* sql`UPDATE human_occurrences SET state='cancelled-on-Stop',pending_context=NULL,settled_at=${time} WHERE id=${occurrence.id}`;
            yield* sql`UPDATE run_blocks SET state='stopped' WHERE run_id=${id} AND block_id=${occurrence.block_id}`;
            yield* settleStopAttention(sql, id, time, occurrence.id);
            yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${id},${occurrence.block_id},'human-cancelled-on-Stop',${"human-stop:" + occurrence.id},${occurrence.id},${time})`;
          }
          yield* sql`INSERT INTO run_events(run_id,kind,source_key,observed_at) VALUES(${id},'stop-requested','stop',${time})`;
          return { ok: true as const, value: undefined };
        }),
      );
      if (!accepted.ok) return accepted;
      yield* lifecycle.fork(drive(id, "dispatch"));
      return yield* getRun(id);
    });
  }
  function settleStopAttention(
    sql: SqlClient.SqlClient,
    id: string,
    time: string,
    occurrenceId?: string,
  ) {
    return Effect.gen(function* () {
      const pending = yield* sql<{
        id: string;
        block_id: string;
        execution_id: string;
      }>`SELECT * FROM run_attention WHERE run_id=${id} AND settled_at IS NULL AND (${occurrenceId ?? null} IS NULL OR occurrence_id=${occurrenceId ?? null})`;
      for (const attentionEntry of pending) {
        yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='cancelled-on-Stop' WHERE id=${attentionEntry.id}`;
        yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${id},${attentionEntry.block_id},${attentionEntry.execution_id},'attention-settled',${"attention-settled:" + attentionEntry.id},${attentionEntry.id},${time})`;
      }
    });
  }
  function stopObservationsUnavailable(id: string) {
    return mutate(id, (sql) =>
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE run_blocks SET freshness='stale' WHERE run_id=${id} AND thread_id IS NOT NULL AND freshness!='stale' AND EXISTS(SELECT 1 FROM runs WHERE id=${id} AND closed_at IS NULL) RETURNING block_id`;
        if (changed.length) {
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${id}`;
          yield* sql`INSERT INTO run_events(run_id,kind,source_key,observed_at) VALUES(${id},'stop-observation-unavailable',${yield* newId},${yield* now})`;
        }
      }),
    );
  }
  /** Interrupts every unfinished worker thread, then confirms Stopped once every worker thread
   * is finished under the shared rule and no operation outcome is unknown. */
  function reconcileStop(runRow: RunRow) {
    return recoverOperation(
      Effect.gen(function* () {
        const blocks = yield* database.transaction(
          (sql) =>
            sql<{
              block_id: string;
              thread_id: string;
            }>`SELECT block_id,thread_id FROM run_blocks WHERE run_id=${runRow.id} AND thread_id IS NOT NULL ORDER BY rowid`,
        );
        const observed = yield* observeWorkers(t3, runRow, blocks);
        for (const { worker, member } of observed)
          if (!worker.finished) yield* requestThreadStop(runRow, member.threadId, worker);
        // Closing in this pass after an interrupt would reuse observations taken before it.
        yield* mutate(runRow.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
            const time = yield* now;
            yield* sql`UPDATE run_blocks SET freshness='fresh',problem='Stop awaiting confirmation that every worker thread has finished.' WHERE run_id=${runRow.id} AND thread_id IS NOT NULL`;
            const [current] = yield* sql<{
              generation: number;
            }>`SELECT generation FROM runs WHERE id=${runRow.id}`;
            if (observed.some(({ worker }) => !worker.finished)) return;
            if (current?.generation !== runRow.generation) return;
            const pending =
              yield* sql`SELECT id FROM operation_intents WHERE run_id=${runRow.id} AND state NOT IN ('acknowledged','cancelled')`;
            if (pending.length) return;
            const attempt = {
              runId: runRow.id,
              generation: runRow.generation,
              contextId: runRow.context_id,
              gateOpen: false,
              frontier: observed.map(({ member }) => member),
            };
            if (!(yield* confirmClosure(sql, owner, attempt, "stopped"))) return;
            yield* sql`UPDATE run_blocks SET state=CASE WHEN state IN ('not-started','finished') THEN state ELSE 'stopped' END,problem=NULL WHERE run_id=${runRow.id}`;
            yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='cancelled-on-Stop' WHERE run_id=${runRow.id} AND settled_at IS NULL`;
          }),
        );
      }),
      () => stopObservationsUnavailable(runRow.id),
    );
  }
  /** One durable interrupt per worker thread and latest run; T3 stops the thread and its
   * delegated work without an execution fence, so a run started later gets its own request. */
  function requestThreadStop(
    run: RunRow,
    threadId: string,
    worker: import("./worker-thread.ts").WorkerThread,
  ) {
    return Effect.gen(function* () {
      const cause = `interrupt:${threadId}:${worker.latest?.runId ?? ""}`;
      const payload = { threadId, clientRequestId: fingerprint(`${run.id}:${cause}`) };
      const reserved = yield* mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return false;
          const rows =
            yield* sql`INSERT INTO run_root_stop_intents(run_id,cause,thread_id,payload_json,state) SELECT ${run.id},${cause},${threadId},${JSON.stringify(payload)},'reserved' FROM runs WHERE id=${run.id} AND gate_open=0 AND stop_requested_at IS NOT NULL ON CONFLICT DO NOTHING RETURNING cause`;
          if (rows.length) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          return rows.length > 0;
        }),
      );
      if (!reserved) return;
      yield* recoverOperation(
        Effect.gen(function* () {
          const support = yield* Effect.tryPromise(() => t3.inspectStopSupport(runTarget(run)));
          if (support.supported)
            yield* Effect.tryPromise(() => t3.stopThread(runTarget(run), payload));
        }),
        () => Effect.void,
      );
      yield* mutate(
        run.id,
        (sql) =>
          sql`UPDATE run_root_stop_intents SET state='uncertain' WHERE run_id=${run.id} AND cause=${cause} AND state='reserved'`,
      );
    });
  }
  return { stopRun, reconcileStop, stopObservationsUnavailable };
}

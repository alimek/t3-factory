import { rootUnavailable } from "./run-root-ledger.ts";
import { rootFrontier } from "./run-root-frontier.ts";
import { reconcileCoordinatorStop } from "./runner-coordinator-stop.ts";
import { completeCoordinator } from "./runner-coordinator-completion.ts";
import { recoverOperation } from "./runner-effects.ts";
import { newId } from "./ids.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { HumanRow, IntentRow, RunnerLifecycle, RunRow } from "./runner-types.ts";
import { coverageProblem } from "./runner-utils.ts";
import { now } from "./time.ts";
export function openRunnerStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  const { mutate, owner } = database;
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
          const owned = yield* sql`SELECT token FROM runner_owner WHERE token=${owner.token}`;
          if (!owned.length) return failure("conflict", "Runner ownership changed.");
          const time = yield* now;
          yield* sql`UPDATE runs SET gate_open=0,stop_requested_at=${time},generation=generation+1 WHERE id=${id}`;
          const pending =
            yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${id} AND (state='pending' OR (state='reserved' AND id IN (SELECT intent_id FROM run_coordinator_commands WHERE run_id=${id} AND state='pending')))`;
          for (const intent of pending) {
            yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem='cancelled-on-Stop',reconciled_at=${time} WHERE id=${intent.id}`;
            yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${id},${intent.block_id},'operation-cancelled',${"cancelled:" + intent.id},${intent.id},${time})`;
          }
          yield* sql`INSERT INTO run_root_cancelled_controls(run_id,source_execution_id) SELECT run_id,source_execution_id FROM run_control_recoveries WHERE run_id=${id} AND state='pending' ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE run_coordinators SET state='cancelled',payload_json=NULL WHERE run_id=${id} AND state='pending'`;
          yield* sql`UPDATE run_coordinator_commands SET cancelled_at=${time} WHERE run_id=${id} AND state='pending'`;
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
  function stopObservationsUnavailable(id: string, error?: unknown) {
    return Effect.gen(function* () {
      const coverage = coverageProblem(error);
      yield* rootUnavailable(database, id);
      yield* mutate(id, (sql) =>
        Effect.gen(function* () {
          const changed =
            yield* sql`UPDATE run_blocks SET freshness='stale',problem=COALESCE(${coverage},problem) WHERE run_id=${id} AND thread_id IS NOT NULL AND (freshness!='stale' OR (${coverage} IS NOT NULL AND problem IS NOT ${coverage})) AND EXISTS(SELECT 1 FROM runs WHERE id=${id} AND closed_at IS NULL) RETURNING block_id`;
          if (changed.length) {
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${id}`;
            yield* sql`INSERT INTO run_events(run_id,kind,source_key,observed_at) VALUES(${id},'stop-observation-unavailable',${yield* newId},${yield* now})`;
          }
        }),
      );
    });
  }
  /** Called by the single dispatch worker; Stop runs over the Run-owned conversation and worker tree. */
  function reconcileStop(runRow: RunRow) {
    return recoverOperation(
      Effect.gen(function* () {
        const root = yield* rootFrontier(database, t3, runRow, true);
        yield* reconcileCoordinatorStop(
          database,
          t3,
          runRow,
          () => stopObservationsUnavailable(runRow.id),
          root,
        );
      }),
      () => stopObservationsUnavailable(runRow.id),
    );
  }
  function attemptSuccessfulClosure(id: string) {
    return completeCoordinator(database, t3, id, liveContextId);
  }
  return { stopRun, reconcileStop, stopObservationsUnavailable, attemptSuccessfulClosure };
}

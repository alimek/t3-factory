import { newId } from "./ids.ts";
import * as Effect from "effect/Effect";
import { makeRunLanes } from "./runner-lanes.ts";
import * as SqlClient from "effect/sql/SqlClient";
import type { IntentRow, RunRow } from "./runner-types.ts";
import { now } from "./time.ts";
import { readRunDefinitions } from "./run-definitions.ts";
/** The sole owner of local Run mutation lanes and SQL transaction boundaries. */
export function openRunnerDatabase(sqlClient: SqlClient.SqlClient, owner: { token: string }) {
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sqlClient));
  const transaction = <A>(
    fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
  ) =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(fn(sql));
      }),
    );
  const { serial, drain } = makeRunLanes();
  const mutate = <A>(
    id: string,
    fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
  ) => serial(id, () => transaction(fn));
  function row(id: string) {
    return Effect.gen(function* () {
      return yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [runRow] = yield* sql<
            Omit<RunRow, "definitions">
          >`SELECT r.*, t.project_id, t.title, c.endpoint, c.environment_id, p.project_id AS t3_project_id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN t3_authorization_contexts c ON c.id=r.context_id JOIN projects p ON p.id=t.project_id WHERE r.id=${id}`;
          return runRow && { ...runRow, definitions: yield* readRunDefinitions(sql, runRow) };
        }),
      );
    });
  }
  /** Observations apply only to an open Run under this owner and its unchanged authorization context. */
  function runHeldUnderContext(sql: SqlClient.SqlClient, runRow: RunRow, requireOpenGate = false) {
    return Effect.gen(function* () {
      const [held] = yield* sql<{
        closed_at: string | null;
        token: string;
        live_context: string;
        gate_open: number;
      }>`
          SELECT r.closed_at,r.gate_open,o.token,c.context_id AS live_context FROM runs r
          JOIN runner_owner o ON o.singleton=1 JOIN t3_connection c ON c.singleton=1 WHERE r.id=${runRow.id}`;
      return (
        !!held &&
        !held.closed_at &&
        held.token === owner.token &&
        held.live_context === runRow.context_id &&
        (!requireOpenGate || Boolean(held.gate_open))
      );
    });
  }
  function problem(intent: IntentRow, message: string) {
    return Effect.gen(function* () {
      yield* mutate(intent.run_id, (sql) =>
        Effect.gen(function* () {
          const time = yield* now;
          const changed =
            yield* sql`UPDATE operation_intents SET state=CASE WHEN state='reserved' THEN 'uncertain' ELSE state END,problem=${message},reconciled_at=${time} WHERE id=${intent.id} AND state NOT IN ('acknowledged','cancelled') AND (problem IS NOT ${message} OR state='reserved') RETURNING id`;
          if (changed.length) {
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${intent.run_id}`;
            yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${intent.run_id},${intent.block_id},'operation-unresolved',${yield* newId},${intent.id},${time})`;
          }
        }),
      );
    });
  }
  function reserveIntent(
    runRow: RunRow,
    intent: IntentRow,
    retryScope: string | null,
    releaseGeneration?: number,
  ) {
    return mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE operation_intents SET state='reserved',reserved_by=${owner.token},reserved_at=${yield* now},retry_scope=${intent.state === "pending" ? retryScope : intent.retry_scope},problem=NULL
        WHERE id=${intent.id} AND state=${intent.state}
        AND (${releaseGeneration ?? null} IS NULL OR EXISTS(SELECT 1 FROM runs WHERE id=${runRow.id} AND generation=${releaseGeneration ?? null}))
        AND EXISTS(SELECT 1 FROM runs WHERE id=${runRow.id} AND closed_at IS NULL AND (gate_open=1 OR (stop_requested_at IS NOT NULL AND ${intent.state !== "pending" ? 1 : 0}=1)))
        AND EXISTS(SELECT 1 FROM projects WHERE id=${runRow.project_id} AND workspace_root=${runRow.workspace_root} AND availability='available')
        AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${intent.context_id})
        AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${owner.token})
        AND (${intent.cause.startsWith("recovery:") && intent.state === "pending" ? 1 : 0}=0 OR EXISTS(
          SELECT 1 FROM report_recoveries rr JOIN run_executions e ON e.run_id=rr.run_id AND e.block_id=rr.block_id AND e.execution_id=rr.source_execution_id
          JOIN run_blocks b ON b.run_id=rr.run_id AND b.block_id=rr.block_id
          WHERE rr.intent_id=${intent.id} AND e.engine_status='completed' AND e.report_status IS NULL AND b.execution_id=e.execution_id AND b.pending_request_count=0))
        AND NOT EXISTS(SELECT 1 FROM operation_intents WHERE run_id=${runRow.id} AND state='reserved' AND id!=${intent.id}) RETURNING id`;
        if (changed.length && releaseGeneration !== undefined && intent.report_id) {
          yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${intent.block_id},'handoff-released',${"release:" + intent.id},${intent.id},${yield* now}) ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${yield* now}) WHERE id=${intent.report_id} AND activation_id IS NOT NULL`;
        }
        if (changed.length)
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
        return changed.length > 0;
      }),
    );
  }
  return {
    run,
    owner,
    serial,
    mutate,
    row,
    transaction,
    runHeldUnderContext,
    problem,
    reserveIntent,
    initialize() {
      return Effect.gen(function* () {
        yield* transaction((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO runner_owner(singleton,token,pid,acquired_at) VALUES(1,${owner.token},${process.pid},${yield* now}) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,pid=excluded.pid,acquired_at=excluded.acquired_at`;
            yield* sql`UPDATE operation_intents SET state='uncertain',problem='Previous owner exited with an in-flight reservation.' WHERE state='reserved'`;
            yield* sql`UPDATE run_coordinators SET state='uncertain',problem='Previous owner exited with an in-flight Run conversation launch.' WHERE state='reserved'`;
            yield* sql`UPDATE run_control_recoveries SET state='uncertain' WHERE state='reserved'`;
            yield* sql`UPDATE run_root_stop_intents SET state='uncertain' WHERE state='reserved'`;
            yield* sql`UPDATE run_coordinator_commands SET state='uncertain' WHERE state='reserved'`;
            yield* sql`UPDATE run_coordinators SET freshness='stale' WHERE run_id IN(SELECT id FROM runs WHERE closed_at IS NULL)`;
            yield* sql`UPDATE run_blocks SET freshness='stale' WHERE thread_id IS NOT NULL AND run_id IN(SELECT id FROM runs WHERE closed_at IS NULL)`;
          }),
        );
      });
    },
    drain,
  };
}
export type RunnerDatabase = ReturnType<typeof openRunnerDatabase>;

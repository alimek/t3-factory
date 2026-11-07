import { settleReportRejections } from "./runner-report-diagnostics.ts";
import { rootControlDispatchAllowed } from "./run-control-recovery-proof.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { coordinatorGate } from "./runner-coordinator-gate.ts";
import { confirmClosure } from "./runner-closure.ts";
import { recoverOperation } from "./runner-effects.ts";
import { runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";
/** Successful closure over the Run-owned tree; stopped closure has its own terminal-work policy. */
export function completeCoordinator(
  database: RunnerDatabase,
  t3: T3Adapter,
  id: string,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  return recoverOperation(
    Effect.gen(function* () {
      const run = yield* database.row(id);
      if (!run || run.closed_at || !run.gate_open) return;
      const attempt = yield* coordinatorGate(database, t3, run);
      if (!attempt) return;
      const support = yield* Effect.tryPromise(() =>
        t3.inspectSettleSupport(runTarget(run)).catch(() => null),
      );
      if (support?.supported)
        for (const member of attempt.frontier) {
          if (!(yield* coordinatorGate(database, t3, run))) return;
          if ((yield* liveContextId()) !== run.context_id) return;
          yield* database.serial(id, () =>
            Effect.gen(function* () {
              const claimed = yield* database.transaction((sql) =>
                Effect.gen(function* () {
                  if (!(yield* database.runHeldUnderContext(sql, run))) return false;
                  const [current] = yield* sql<{
                    generation: number;
                  }>`SELECT generation FROM runs WHERE id=${id}`;
                  if (current?.generation !== attempt.generation) return false;
                  const rows =
                    yield* sql`INSERT INTO coordinator_settlements(run_id,thread_id,execution_id,attempted_at) VALUES(${id},${member.threadId},${member.latestRunId!},${yield* now}) ON CONFLICT DO NOTHING RETURNING thread_id`;
                  return rows.length > 0;
                }),
              );
              if (claimed)
                yield* recoverOperation(
                  Effect.tryPromise(() =>
                    t3.settleThread(runTarget(run), { threadId: member.threadId }),
                  ),
                  () => Effect.void,
                );
            }),
          );
        }
      // Settlement is an external effect; obtain a new frontier before permanent closure.
      const fresh = yield* coordinatorGate(database, t3, run);
      if (!fresh || (yield* liveContextId()) !== run.context_id) return;
      yield* database.mutate(id, (sql) =>
        Effect.gen(function* () {
          const pending =
            yield* sql`SELECT id FROM operation_intents WHERE run_id=${id} AND state!='acknowledged' UNION ALL SELECT id FROM human_occurrences WHERE run_id=${id} AND state!='answered'`;
          if (pending.length) return;
          if (!(yield* rootControlDispatchAllowed(sql, id))) return;
          const closed = yield* confirmClosure(sql, database.owner.token, fresh, "finished");
          if (closed) {
            yield* sql`UPDATE run_activations SET phase='finished',problem=NULL WHERE run_id=${id}`;
            const time = yield* now;
            yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE run_id=${id}`;
            // Terminal activations have no handoff release to settle their recovery diagnostics.
            const reports = yield* sql<{
              block_id: string;
              execution_id: string;
            }>`SELECT block_id,execution_id FROM runtime_reports WHERE run_id=${id}`;
            for (const report of reports)
              yield* settleReportRejections(
                sql,
                id,
                report.block_id,
                report.execution_id,
                time,
                true,
              );
          }
        }),
      );
    }),
    () => Effect.void,
  );
}

import { settleReportRejections } from "./runner-report-diagnostics.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { confirmClosure, observeWorkers, type ClosureAttempt } from "./runner-closure.ts";
import { recoverOperation } from "./runner-effects.ts";
import { runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";

/** Every visited Block's current activation has a finished result and no later working report,
 * nothing is pending locally, and every worker thread is finished under the shared rule. */
function finishedAttempt(database: RunnerDatabase, t3: T3Adapter, run: RunRow) {
  return Effect.gen(function* () {
    const local = yield* database.transaction((sql) =>
      Effect.gen(function* () {
        const blocks = yield* sql<{
          block_id: string;
          thread_id: string;
          reported: number;
          working: number;
        }>`SELECT b.block_id,b.thread_id,EXISTS(SELECT 1 FROM runtime_reports r WHERE r.activation_id=a.id) AS reported,EXISTS(SELECT 1 FROM working_reports w WHERE w.activation_id=a.id AND w.replaced_at IS NULL) AS working FROM run_blocks b LEFT JOIN run_activations a ON a.id=(SELECT id FROM run_activations WHERE run_id=b.run_id AND block_id=b.block_id ORDER BY rowid DESC LIMIT 1) WHERE b.run_id=${run.id} AND b.thread_id IS NOT NULL ORDER BY b.rowid`;
        const pending =
          yield* sql`SELECT id FROM run_attention WHERE run_id=${run.id} AND settled_at IS NULL`;
        return { blocks, pending: pending.length > 0 };
      }),
    );
    if (!local.blocks.length || local.pending || local.blocks.some((b) => !b.reported || b.working))
      return null;
    const observed = yield* observeWorkers(t3, run, local.blocks);
    if (observed.some(({ worker }) => !worker.finished)) return null;
    return {
      runId: run.id,
      generation: run.generation,
      gateOpen: true,
      contextId: run.context_id,
      frontier: observed.map(({ member }) => member),
    } satisfies ClosureAttempt;
  });
}

/** Successful closure; Stop has its own terminal policy. */
export function completeRun(
  database: RunnerDatabase,
  t3: T3Adapter,
  id: string,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  return recoverOperation(
    Effect.gen(function* () {
      const run = yield* database.row(id);
      if (!run || run.closed_at || !run.gate_open) return;
      const attempt = yield* finishedAttempt(database, t3, run);
      if (!attempt) return;
      yield* settleWorkerThreads(database, t3, run, attempt, liveContextId);
      // Settlement is an external effect; obtain a new frontier before permanent closure.
      const fresh = yield* finishedAttempt(database, t3, run);
      if (!fresh || (yield* liveContextId()) !== run.context_id) return;
      yield* database.mutate(id, (sql) =>
        Effect.gen(function* () {
          // A replaced result's held handoffs are cancelled and owe no delivery.
          const pending =
            yield* sql`SELECT id FROM operation_intents WHERE run_id=${id} AND state!='acknowledged' AND NOT (kind='handoff' AND state='cancelled') UNION ALL SELECT id FROM human_occurrences WHERE run_id=${id} AND state!='answered'`;
          if (pending.length) return;
          if (!(yield* confirmClosure(sql, database.owner.token, fresh, "finished"))) return;
          yield* sql`UPDATE run_activations SET phase='finished',problem=NULL WHERE run_id=${id}`;
          const time = yield* now;
          yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE run_id=${id}`;
          // Terminal activations have no handoff release to settle their recovery diagnostics.
          const reports = yield* sql<{
            block_id: string;
          }>`SELECT DISTINCT block_id FROM runtime_reports WHERE run_id=${id}`;
          for (const report of reports)
            yield* settleReportRejections(sql, id, report.block_id, time);
        }),
      );
    }),
    () => Effect.void,
  );
}

/** Best-effort native organization before closure. A possibly issued settlement is never
 * replayed, so a manual reopen in T3 is preserved. */
function settleWorkerThreads(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  attempt: ClosureAttempt,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  return Effect.gen(function* () {
    const support = yield* Effect.tryPromise(() =>
      t3.inspectSettleSupport(runTarget(run)).catch(() => null),
    );
    if (!support?.supported) return;
    for (const member of attempt.frontier) {
      if (!member.latestRunId || (yield* liveContextId()) !== run.context_id) return;
      const claimed = yield* database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return false;
          const [current] = yield* sql<{
            generation: number;
          }>`SELECT generation FROM runs WHERE id=${run.id}`;
          if (current?.generation !== attempt.generation) return false;
          const rows =
            yield* sql`INSERT INTO coordinator_settlements(run_id,thread_id,execution_id,attempted_at) VALUES(${run.id},${member.threadId},${member.latestRunId!},${yield* now}) ON CONFLICT DO NOTHING RETURNING thread_id`;
          return rows.length > 0;
        }),
      );
      if (claimed)
        yield* recoverOperation(
          Effect.tryPromise(() => t3.settleThread(runTarget(run), { threadId: member.threadId })),
          () => Effect.void,
        );
    }
  });
}

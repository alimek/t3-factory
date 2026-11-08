import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { readWorkerThread } from "./worker-thread.ts";
import { now } from "./time.ts";

/** Releases an activation's finished result once, when its Block's worker thread is finished and
 * no execution failure is pending on that Block. Recipients remain independent pending intents. */
export function releaseResult(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  activationId: string,
) {
  return Effect.gen(function* () {
    const [source] = yield* database.transaction(
      (sql) =>
        sql<{
          released: number;
          thread_id: string | null;
        }>`SELECT EXISTS(SELECT 1 FROM coordinator_releases WHERE activation_id=${activationId} AND context_id=${run.context_id}) AS released,b.thread_id FROM runtime_reports r JOIN run_blocks b ON b.run_id=r.run_id AND b.block_id=r.block_id WHERE r.activation_id=${activationId}`,
    );
    if (!source?.thread_id) return false;
    if (source.released) return true;
    const worker = yield* Effect.tryPromise(() => readWorkerThread(t3, run, source.thread_id!));
    if (!worker.finished) return false;
    return yield* database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
        const [current] =
          yield* sql`SELECT id FROM runs WHERE id=${run.id} AND generation=${run.generation}`;
        if (!current) return false;
        const failed =
          yield* sql`SELECT a.id FROM run_attention a JOIN runtime_reports r ON r.run_id=a.run_id AND r.block_id=a.block_id WHERE r.activation_id=${activationId} AND a.kind='execution-failed' AND a.settled_at IS NULL`;
        if (failed.length) return false;
        const time = yield* now;
        const rows =
          yield* sql`INSERT INTO coordinator_releases(activation_id,report_id,generation,context_id,released_at) SELECT activation_id,id,${run.generation},${run.context_id},${time} FROM runtime_reports WHERE activation_id=${activationId} ON CONFLICT DO NOTHING RETURNING report_id`;
        if (!rows.length) return false;
        yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE activation_id=${activationId}`;
        yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) SELECT run_id,block_id,'handoff-released','release:'||id,id,${time} FROM operation_intents WHERE report_id=(SELECT report_id FROM coordinator_releases WHERE activation_id=${activationId}) ON CONFLICT DO NOTHING`;
        return true;
      }),
    );
  });
}

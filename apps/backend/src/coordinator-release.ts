import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { coordinatorGate } from "./runner-coordinator-gate.ts";
import { now } from "./time.ts";

/** Commit source completion once, before reusing its conversations. Recipients
 * remain independent pending intents; neither busy targets nor self-loops join. */
export function releaseCoordinatorSource(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  blockId: string,
  activationId: string,
) {
  return Effect.gen(function* () {
    const [released] = yield* database.transaction(
      (sql) =>
        sql`SELECT activation_id FROM coordinator_releases WHERE activation_id=${activationId} AND context_id=${run.context_id}`,
    );
    if (released) return true;
    const attempt = yield* coordinatorGate(database, t3, run, blockId, activationId);
    if (!attempt) return false;
    return yield* database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
        const [current] =
          yield* sql`SELECT id FROM runs WHERE id=${run.id} AND generation=${attempt.generation}`;
        if (!current) return false;
        const time = yield* now;
        const rows =
          yield* sql`INSERT INTO coordinator_releases(activation_id,report_id,generation,context_id,frontier_json,released_at) SELECT activation_id,id,${attempt.generation},${run.context_id},${JSON.stringify(attempt)},${time} FROM runtime_reports WHERE activation_id=${activationId} ON CONFLICT DO NOTHING RETURNING report_id`;
        if (!rows.length) return false;
        yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE activation_id=${activationId}`;
        yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) SELECT run_id,block_id,'handoff-released','release:'||id,id,${time} FROM operation_intents WHERE report_id=(SELECT report_id FROM coordinator_releases WHERE activation_id=${activationId}) ON CONFLICT DO NOTHING`;
        return true;
      }),
    );
  });
}

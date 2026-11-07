import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { ownedRootControlExecutions } from "./run-control-recovery-proof.ts";
import { runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";

/** Retain unsuccessful terminal control observations before any dependent native read. */
export function observeRootControl(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
) {
  return Effect.gen(function* () {
    const owned = yield* database.transaction((sql) => ownedRootControlExecutions(sql, run.id));
    const observation = yield* Effect.tryPromise(() =>
      t3.readExecution(runTarget(run), threadId, owned),
    );
    if (
      observation.threadId !== threadId ||
      observation.projectId !== run.t3_project_id ||
      (observation.workspaceRoot !== null && observation.workspaceRoot !== run.workspace_root)
    )
      throw Error("Root execution scope changed.");
    yield* database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, run))) return;
        for (const execution of observation.recentRuns) {
          if (
            !["failed", "cancelled", "interrupted", "rolled_back"].includes(execution.status) ||
            !owned.some((source) => source.runId === execution.runId)
          )
            continue;
          const source =
            execution.status === "rolled_back"
              ? "root-control-rolled-back:"
              : "root-control-failed:";
          yield* sql`INSERT INTO run_events(run_id,execution_id,kind,source_key,observed_at,engine_status) VALUES(${run.id},${execution.runId},'execution-observed',${source + execution.runId},${yield* now},${execution.status}) ON CONFLICT DO NOTHING`;
        }
        const status =
          observation.recentRuns.find(
            (execution) => execution.runId === (observation.activeRunId ?? observation.latestRunId),
          )?.status ?? null;
        yield* sql`UPDATE run_coordinators SET engine_status=${status} WHERE run_id=${run.id}`;
      }),
    );
    return observation;
  });
}

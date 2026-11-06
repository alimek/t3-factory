import { newId } from "./ids.ts";
import type { RunClosure } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ExecutionObservation } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { now } from "./time.ts";
import { ownedRootControlExecutions } from "./run-control-recovery-proof.ts";

/** Existing event storage retains observations; no inferred start/end or Block membership. */
export function recordRootWork(
  database: RunnerDatabase,
  run: RunRow,
  observation: ExecutionObservation,
) {
  return database.mutate(run.id, (sql) =>
    Effect.gen(function* () {
      const [root] =
        yield* sql`SELECT run_id FROM run_coordinators WHERE run_id=${run.id} AND thread_id=${observation.threadId}`;
      if (!root || !(yield* database.runHeldUnderContext(sql, run))) return;
      const current = observation.recentRuns.find(
        (e) => e.runId === (observation.activeRunId ?? observation.latestRunId),
      );
      yield* sql`UPDATE run_coordinators SET engine_status=${current?.status ?? null} WHERE run_id=${run.id}`;
      for (const execution of observation.recentRuns) {
        const [last] = yield* sql<{
          engine_status: string;
        }>`SELECT engine_status FROM run_events WHERE run_id=${run.id} AND block_id IS NULL AND execution_id=${execution.runId} AND kind='root-work-observed' ORDER BY sequence DESC LIMIT 1`;
        if (last?.engine_status === execution.status) continue;
        yield* sql`INSERT INTO run_events(run_id,execution_id,kind,source_key,observed_at,engine_status,source_at) VALUES(${run.id},${execution.runId},'root-work-observed',${"root-work:" + (yield* newId)},${yield* now},${execution.status},${execution.sourceAt ?? null}) ON CONFLICT DO NOTHING`;
      }
    }),
  );
}
export function readRootWork(sql: SqlClient.SqlClient, runId: string) {
  return Effect.gen(function* () {
    const owned = yield* ownedRootControlExecutions(sql, runId);
    const rows = yield* sql<{
      executionId: string;
      engineStatus: string | null;
      observedStartedAt: string | null;
      observedEndedAt: string | null;
    }>`SELECT ids.execution_id AS executionId,
      (SELECT e.engine_status FROM run_events e WHERE e.run_id=${runId} AND e.block_id IS NULL AND e.execution_id=ids.execution_id AND e.engine_status IS NOT NULL ORDER BY e.sequence DESC LIMIT 1) AS engineStatus,
      (SELECT MIN(e.observed_at) FROM run_events e WHERE e.run_id=${runId} AND e.block_id IS NULL AND e.execution_id=ids.execution_id AND e.engine_status IN ('preparing','starting','running','waiting')) AS observedStartedAt,
      (SELECT MIN(e.observed_at) FROM run_events e WHERE e.run_id=${runId} AND e.block_id IS NULL AND e.execution_id=ids.execution_id AND e.engine_status IN ('completed','failed','cancelled','interrupted','rolled_back')) AS observedEndedAt
      FROM (SELECT o.reference AS execution_id FROM run_root_obligations o JOIN run_coordinators c ON c.run_id=o.run_id AND c.thread_id=o.thread_id WHERE o.run_id=${runId} AND o.kind='execution' UNION SELECT execution_id FROM run_events WHERE run_id=${runId} AND block_id IS NULL AND execution_id IS NOT NULL) ids`;
    const [closure] = yield* sql<{
      root_frontier_json: string | null;
    }>`SELECT root_frontier_json FROM run_closures WHERE run_id=${runId}`;
    const [root] = yield* sql<{
      thread_id: string | null;
    }>`SELECT thread_id FROM run_coordinators WHERE run_id=${runId}`;
    const frontier = closure?.root_frontier_json
      ? (JSON.parse(closure.root_frontier_json) as NonNullable<RunClosure["rootFrontier"]>).find(
          (f) => f.threadId === root?.thread_id,
        )
      : undefined;
    return rows.map((row) => ({
      ...row,
      engineStatus:
        frontier?.executions.find((e) => e.executionId === row.executionId)?.status ??
        row.engineStatus ??
        null,
      control: owned.some((e) => e.runId === row.executionId),
    }));
  });
}

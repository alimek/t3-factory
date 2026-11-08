import type { RunClosure } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";
import { readWorkerThread, type WorkerThread } from "./worker-thread.ts";

/** Local token captured before I/O. Both completion and Stop use the same boundary. */
export interface ClosureAttempt {
  readonly runId: string;
  readonly generation: number;
  readonly gateOpen: boolean;
  readonly contextId: string;
  readonly frontier: RunClosure["frontier"];
}
export interface ObservedWorker {
  readonly worker: WorkerThread;
  readonly member: RunClosure["frontier"][number];
}

/** Fresh, separate reads of each Block's worker thread under the shared thread-finished rule.
 * No transaction, saved poll reuse, or message body archive. */
export function observeWorkers(
  t3: T3Adapter,
  run: RunRow,
  blocks: readonly { block_id: string; thread_id: string }[],
): Effect.Effect<ObservedWorker[], unknown> {
  return Effect.gen(function* () {
    const projects = yield* Effect.tryPromise(() => t3.listProjects(runTarget(run)));
    const project = projects.find((project) => project.projectId === run.t3_project_id);
    if (!project?.available || project.workspaceRoot !== run.workspace_root)
      return yield* Effect.fail(Error("Closure project coverage changed"));
    const projectObservedAt = yield* now;
    const observed: ObservedWorker[] = [];
    for (const block of blocks) {
      const worker = yield* Effect.tryPromise(() => readWorkerThread(t3, run, block.thread_id));
      const observedAt = yield* now;
      const { thread } = worker;
      observed.push({
        worker,
        member: {
          environmentId: run.environment_id,
          blockId: block.block_id,
          threadId: block.thread_id,
          projectId: thread.projectId,
          workspaceRoot: project.workspaceRoot,
          projectObservedAt,
          executionObservedAt: observedAt,
          nativeObservedAt: observedAt,
          activeRunId: thread.activeRunId,
          latestRunId: thread.latestRunId ?? null,
          executions: thread.recentRuns.map((execution) => ({
            executionId: execution.runId,
            status: execution.status,
            ordinal: execution.ordinal ?? null,
            sourceAt: execution.sourceAt ?? null,
          })),
          pendingRequestCount: thread.pendingRequestCount,
        },
      });
    }
    return observed;
  });
}

/** Call inside the Run lane AND the policy-validation transaction. No I/O here.
 * The caller checks outcome-specific local and external predicates. */
export function confirmClosure(
  sql: SqlClient.SqlClient,
  ownerToken: string,
  attempt: ClosureAttempt,
  outcome: RunClosure["outcome"],
) {
  return Effect.gen(function* () {
    const time = yield* now;
    const changed =
      yield* sql`UPDATE runs SET closed_at=${time},outcome=${outcome},gate_open=0,generation=generation+1
      WHERE id=${attempt.runId} AND closed_at IS NULL AND generation=${attempt.generation}
      AND gate_open=${attempt.gateOpen ? 1 : 0} AND context_id=${attempt.contextId}
      AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${ownerToken})
      AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${attempt.contextId}) RETURNING id`;
    if (!changed.length) return false;
    yield* sql`UPDATE run_root_stop_intents SET state='acknowledged' WHERE run_id=${attempt.runId}`;
    yield* sql`INSERT INTO run_closures(run_id,outcome,generation,confirmed_at,frontier_json)
      VALUES(${attempt.runId},${outcome},${attempt.generation},${time},${JSON.stringify(attempt.frontier)})`;
    yield* sql`INSERT INTO run_events(run_id,kind,source_key,cause_id,observed_at)
      VALUES(${attempt.runId},'run-closed','closure',${attempt.runId},${time})`;
    return true;
  });
}

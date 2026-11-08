import { currentReports, settleQuestions, type CurrentReport } from "./block-report.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunAttention } from "@t3-factory/contracts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import { newId } from "./ids.ts";
import { attention, settlePending } from "./runner-attention.ts";
import { recoverOperation } from "./runner-effects.ts";
import { now } from "./time.ts";
import { failedRun, readWorkerThread, type WorkerThread } from "./worker-thread.ts";

/** Observes each Block's worker thread and derives its execution failure, missing report and
 * native-request attention from the shared thread-finished rule. */
export function openRunnerObservation(database: RunnerDatabase, t3: T3Adapter) {
  function observe(runRow: RunRow, block: BlockRow, contextId: string | null) {
    return recoverOperation(
      Effect.gen(function* () {
        if (contextId !== runRow.context_id) throw Error("Authorization context changed.");
        const run = yield* database.row(runRow.id);
        const [current] = yield* database.transaction(
          (sql) =>
            sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runRow.id} AND block_id=${block.block_id}`,
        );
        if (!run || !current?.thread_id) return;
        const worker = yield* Effect.tryPromise(() =>
          readWorkerThread(t3, run, current.thread_id!),
        );
        yield* database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, run))) return;
            // A report or handoff accepted during the read makes this observation stale.
            const [unchanged] =
              yield* sql`SELECT id FROM runs WHERE id=${run.id} AND generation=${run.generation}`;
            if (!unchanged) return;
            yield* recordWorkerThread(sql, run, current, worker, yield* now);
          }),
        );
      }),
      () =>
        database.mutate(runRow.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
            yield* sql`UPDATE run_blocks SET freshness='stale',problem='Worker thread observation unavailable.' WHERE run_id=${runRow.id} AND block_id=${block.block_id}`;
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
          }),
        ),
    );
  }
  return { observe };
}

function recordWorkerThread(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  worker: WorkerThread,
  time: string,
) {
  return Effect.gen(function* () {
    const { thread, latest } = worker;
    const [binding] = yield* sql<{
      id: string;
    }>`SELECT id FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${thread.threadId}`;
    if (!binding) throw Error("Worker binding is missing.");
    yield* sql`UPDATE run_thread_bindings SET link=COALESCE(${thread.link},link) WHERE id=${binding.id}`;
    const scope = { block_id: block.block_id, bindingId: binding.id };
    yield* attention(
      sql,
      run,
      scope,
      latest?.runId ?? "",
      "native-request",
      thread.pendingRequestCount > 0,
      time,
    );
    yield* recordExecutions(sql, run, block, binding.id, worker, time);
    if (latest && failedRun(latest.status))
      yield* attention(sql, run, block, latest.runId, "execution-failed", true, time);
    // A later run of the thread that completes recovers earlier execution failures.
    if (latest?.status === "completed")
      yield* settlePending(sql, run.id, block.block_id, "execution-failed", "completed", time);
    yield* settleQuestions(sql, run.id, block.block_id, time);
    yield* recordActivation(sql, run, block, worker, time);
    yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
  });
}

function recordExecutions(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  bindingId: string,
  { thread }: WorkerThread,
  time: string,
) {
  return Effect.gen(function* () {
    for (const execution of thread.recentRuns) {
      const [previous] = yield* sql<{
        engine_status: string;
      }>`SELECT engine_status FROM run_executions WHERE run_id=${run.id} AND thread_id=${thread.threadId} AND execution_id=${execution.runId}`;
      const problem = failedRun(execution.status) ? "execution-failed" : null;
      yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,binding_id,engine_status,ordinal,observed_at,problem,native_request_count) VALUES(${run.id},${block.block_id},${thread.threadId},${execution.runId},${bindingId},${execution.status},${execution.ordinal ?? null},${time},${problem},${thread.pendingRequestCount}) ON CONFLICT(run_id,thread_id,execution_id) DO UPDATE SET engine_status=excluded.engine_status,ordinal=COALESCE(excluded.ordinal,run_executions.ordinal),observed_at=excluded.observed_at,problem=excluded.problem,native_request_count=excluded.native_request_count`;
      if (previous?.engine_status !== execution.status)
        yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,observed_at,engine_status) VALUES(${run.id},${block.block_id},${execution.runId},${bindingId},'execution-observed',${yield* newId},${time},${execution.status})`;
    }
  });
}

type ReportStatus = CurrentReport["status"] | undefined;

/** Missing report: the thread is finished, its latest run completed, and the current activation
 * has no current report. */
function missingReport({ finished, latest }: WorkerThread, current: ReportStatus) {
  return finished && latest?.status === "completed" && !current;
}

function blockState(problem: string | null, { finished }: WorkerThread, current: ReportStatus) {
  if (problem) return "error";
  if (current === "waiting") return "waiting";
  return current === "finished" && finished ? "finished" : "working";
}

function recordActivation(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  worker: WorkerThread,
  time: string,
) {
  return Effect.gen(function* () {
    const { latest } = worker;
    const activation = (yield* currentReports(sql, run.id)).find(
      (entry) => entry.blockId === block.block_id,
    );
    if (!activation) throw Error("Activation is missing.");
    const current = activation.report?.status;
    if (latest) {
      const missing = missingReport(worker, current);
      yield* attention(sql, run, block, latest.runId, "missing-report", missing, time);
      if (missing)
        yield* sql`UPDATE run_executions SET problem='missing-report' WHERE run_id=${run.id} AND thread_id=${block.thread_id} AND execution_id=${latest.runId}`;
    }
    const [pending] = yield* sql<{
      kind: RunAttention["kind"];
    }>`SELECT kind FROM run_attention WHERE run_id=${run.id} AND block_id=${block.block_id} AND kind IN ('execution-failed','missing-report') AND settled_at IS NULL ORDER BY kind LIMIT 1`;
    const problem = pending?.kind ?? null;
    const phase =
      current === "waiting" ? "waiting-worker" : current === "finished" ? "reported" : "assessing";
    yield* sql`UPDATE run_activations SET phase=CASE WHEN phase='finished' THEN phase ELSE ${phase} END,problem=${problem} WHERE id=${activation.activationId}`;
    yield* sql`UPDATE run_blocks SET execution_id=${latest?.runId ?? block.execution_id},engine_status=${latest?.status ?? null},freshness='fresh',observed_at=${time},pending_request_count=${worker.thread.pendingRequestCount},problem=${problem},state=${blockState(problem, worker, current)} WHERE run_id=${run.id} AND block_id=${block.block_id}`;
  });
}

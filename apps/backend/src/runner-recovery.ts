import { recoverOperation } from "./runner-effects.ts";
import { newId } from "./ids.ts";
import { conversationReportInstructions } from "./runner-handoffs.ts";
import { effectiveExits } from "@t3-factory/domain-validation";
import { workerTurn } from "./runner-block-workers.ts";
import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter, SendPayload } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { readWorkerThread } from "./worker-thread.ts";
import { failure } from "./result.ts";
import { now } from "./time.ts";
export function recoveryRows(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      attention_id: string | null;
      block_id: string;
      source_execution_id: string;
      intent_id: string;
      requested_at: string;
      settled_at: string | null;
      result_json: string | null;
    }>`SELECT r.*,i.result_json FROM report_recoveries r JOIN operation_intents i ON i.id=r.intent_id WHERE r.run_id=${id}`;
    return rows.map((r) => ({
      attentionId: r.attention_id,
      blockId: r.block_id,
      sourceExecutionId: r.source_execution_id,
      intentId: r.intent_id,
      requestedAt: r.requested_at,
      settledAt: r.settled_at,
      executionId: r.result_json
        ? (
            JSON.parse(r.result_json) as {
              runId: string;
            }
          ).runId
        : null,
    }));
  });
}
/** Request report assesses a finished worker thread whose latest run is the one it was asked for. */
function recoveryReady(t3: T3Adapter, run: RunRow, threadId: string, executionId: string) {
  return Effect.tryPromise(async () => {
    const worker = await readWorkerThread(t3, run, threadId);
    return (
      worker.finished &&
      worker.latest?.runId === executionId &&
      worker.latest.status === "completed"
    );
  });
}
export function openRunnerRecovery(
  database: RunnerDatabase,
  lifecycle: RunnerLifecycle,
  t3: T3Adapter,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  const { row, mutate, runHeldUnderContext } = database;
  function requestReport(
    runId: string,
    input: { blockId: string },
  ): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (lifecycle.isClosed()) return failure("conflict", "Factory is shutting down.");
      if (typeof input?.blockId !== "string" || !input.blockId)
        return failure("validation", "Choose the Block to request a report from.");
      const blockId = input.blockId;
      const detail = yield* lifecycle.getRun(runId);
      if (!detail.ok) return detail;
      const b = detail.value.blocks.find((block) => block.blockId === blockId);
      if (!b) return failure("not_found", "This Block is not part of the Run.");
      if (
        detail.value.recoveries.some(
          (r) => r.blockId === blockId && r.sourceExecutionId === b.executionId,
        )
      )
        return detail;
      const visit = detail.value.activations.filter((a) => a.blockId === blockId).at(-1);
      const current = yield* row(runId);
      if (
        !current ||
        !b.threadId ||
        !b.executionId ||
        !visit ||
        detail.value.reports.some((r) => r.activationId === visit.id && r.status === "finished")
      )
        return failure(
          "conflict",
          "Request report needs an Agent Block with a worker thread and no finished result for its current visit. Refresh the Run.",
        );
      const threadId = b.threadId,
        executionId = b.executionId;
      const preflight = yield* recoverOperation(
        Effect.gen(function* () {
          if (
            (yield* liveContextId()) !== current.context_id ||
            !(yield* recoveryReady(t3, current, threadId, executionId))
          )
            return failure(
              "conflict",
              "Request report needs the worker thread finished in T3 with no run newer than the one Factory observed.",
            );
          return { ok: true as const, value: undefined };
        }),
        () =>
          Effect.succeed(
            failure(
              "conflict",
              "The worker thread cannot be read from T3. Refresh before requesting a report.",
            ),
          ),
      );
      if (!preflight.ok) return preflight;
      const accepted = yield* mutate(current.id, (sql) =>
        Effect.gen(function* () {
          const existing =
            yield* sql`SELECT intent_id FROM report_recoveries WHERE run_id=${current.id} AND block_id=${blockId} AND source_execution_id=${executionId}`;
          if (existing.length) return { ok: true as const, value: undefined };
          if (!(yield* runHeldUnderContext(sql, current, true)))
            return failure("conflict", "The Run is stopped, closed, or its authorization changed.");
          const eligible =
            yield* sql`SELECT r.id FROM runs r JOIN run_blocks b ON b.run_id=r.id JOIN run_executions e ON e.run_id=r.id AND e.block_id=b.block_id AND e.execution_id=b.execution_id
        WHERE r.id=${current.id} AND r.generation=${detail.value.generation} AND b.block_id=${blockId} AND b.execution_id=${executionId} AND e.engine_status='completed' AND e.thread_id=${threadId}
        AND NOT EXISTS(SELECT 1 FROM runtime_reports WHERE activation_id=${visit.id})
        AND NOT EXISTS(SELECT 1 FROM operation_intents WHERE run_id=r.id AND block_id=b.block_id AND state NOT IN ('acknowledged','cancelled'))`;
          if (!eligible.length)
            return failure(
              "conflict",
              "The Run changed or has competing work. Refresh before requesting a report.",
            );
          const intentId = yield* newId,
            key = yield* newId,
            time = yield* now;
          const [block] = yield* sql<{
            public_id: string;
          }>`SELECT public_id FROM run_blocks WHERE run_id=${current.id} AND block_id=${blockId}`;
          const [problem] = yield* sql<{
            id: string;
          }>`SELECT id FROM run_attention WHERE run_id=${current.id} AND block_id=${blockId} AND kind='missing-report' AND execution_id=${executionId} AND settled_at IS NULL`;
          const { definitions } = current;
          const exits = effectiveExits(
            definitions.flow.graph.blocks.find((block) => block.id === blockId)!,
            definitions.agents,
          );
          const payload: SendPayload = {
            environmentId: current.environment_id,
            threadId,
            mode: "queue",
            clientRequestId: key,
            message: workerTurn(
              "Factory Request report: assess the existing work without repeating the task. If questions you asked the user are still unanswered, or CI, review, delegated or background work is still running, report working with what remains open instead of forcing completion; report finished only when the task, including its discussion, is actually complete.\n\n" +
                conversationReportInstructions(exits),
              block!.public_id,
            ),
          };
          const body = JSON.stringify(payload);
          yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id) VALUES(${intentId},${current.id},${blockId},'send',${"recovery:" + intentId},${JSON.stringify({ ...runTarget(current), blockId, threadId })},${key},${body},${fingerprint(body)},${current.context_id})`;
          yield* sql`INSERT INTO report_recoveries(intent_id,attention_id,run_id,block_id,source_execution_id,requested_at,thread_scope) VALUES(${intentId},${problem?.id ?? null},${current.id},${blockId},${executionId},${time},${threadId})`;
          yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${current.id},${blockId},${executionId},'report-recovery-requested',${"recovery:" + intentId},${intentId},${time})`;
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${current.id}`;
          return { ok: true as const, value: undefined };
        }),
      );
      if (!accepted.ok) return accepted;
      yield* lifecycle.drive(current.id, "dispatch");
      return yield* lifecycle.getRun(current.id);
    });
  }
  return { requestReport };
}
export function recoveryDispatchGeneration(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: import("./runner-types.ts").IntentRow,
) {
  return Effect.gen(function* () {
    if (!intent.cause.startsWith("recovery:") || intent.state !== "pending") return undefined;
    const current = yield* database.row(runRow.id);
    if (!current) return null;
    const target = JSON.parse(intent.target_json) as {
      threadId: string;
    };
    const recovery = yield* database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{
          source_execution_id: string;
        }>`SELECT source_execution_id FROM report_recoveries WHERE intent_id=${intent.id}`)[0];
      }),
    );
    if (
      !recovery ||
      !(yield* recoveryReady(t3, current, target.threadId, recovery.source_execution_id))
    ) {
      yield* database.problem(
        intent,
        "Recovery target has new activity or pending attention; the accepted request remains unsent.",
      );
      return null;
    }
    return current.generation;
  });
}

import { prepareCheckpoint } from "./coordinator-evidence.ts";
import { checkpointRejection, persistCheckpoint } from "./coordinator-checkpoint.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import { acceptCoordinatorWait, settleCoordinatorWaits } from "./coordinator-conversation.ts";
import { workerReport, settleCoordinatorReports } from "./coordinator-report.ts";
import { newId } from "./ids.ts";
import type { RunSnapshot } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { attention } from "./runner-attention.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { createHandoffs } from "./runner-handoffs.ts";
import type { BlockRow, ReportRow, ReportRunRow, RunnerLifecycle } from "./runner-types.ts";
import { fingerprint, rejected } from "./runner-utils.ts";
import {
  acceptedTransition,
  type RuntimeBinding,
  type RuntimeReply,
  type RuntimeReport,
} from "./runtime-types.ts";
import { now } from "./time.ts";
function reportRetry(
  sql: SqlClient.SqlClient,
  binding: RuntimeBinding,
  key: string,
  content: string,
) {
  return Effect.gen(function* () {
    const [prior] =
      yield* sql<ReportRow>`SELECT * FROM runtime_reports WHERE run_id=${binding.factoryRunId} AND block_id=${binding.blockId} AND execution_id=${binding.runId} AND (report_key=${key} OR final_contract=1) ORDER BY report_key=${key} DESC LIMIT 1`;
    if (!prior) return undefined;
    if (prior.fingerprint !== content)
      return { code: prior.final_contract ? "FINAL_CONFLICT" : "KEY_CONFLICT" };
    return JSON.parse(prior.acknowledgement_json) as RuntimeReply;
  });
}
/** Exact exit names and identities resolve against the captured Flow, never a later edit. */
function reportRoute(snapshot: RunSnapshot, blockId: string, report: RuntimeReport) {
  const block = snapshot.flow.graph.blocks.find((block) => block.id === blockId);
  if (!block || block.kind !== "agent") return rejected("UNBOUND_CALLER");
  const matches = block.exits.filter(
    (candidate) => candidate.name === report.exit || candidate.id === report.exit,
  );
  const exit = matches[0];
  if (report.exit !== undefined && matches.length !== 1)
    return {
      ok: false as const,
      reply: { code: "INVALID_EXIT", allowedExits: block.exits.map((exit) => exit.name) },
    };
  if (exit?.requiresFeedback && !report.message?.trim()) return rejected("FEEDBACK_REQUIRED");
  const recipients = exit
    ? snapshot.flow.graph.connections
        .filter((edge) => edge.sourceBlockId === block.id && edge.exitId === exit.id)
        .map((edge) => edge.targetBlockId)
    : [];
  if (recipients.some((id) => !snapshot.flow.graph.blocks.some((block) => block.id === id)))
    return rejected("INVALID_RECIPIENT");
  return { ok: true as const, exitId: exit?.id ?? null, recipients };
}
/** A waiting report is non-final: it never selects an exit and must say what the worker needs. */
function waitingRejection(report: RuntimeReport) {
  if (report.status === "finished") return undefined;
  if (report.exit !== undefined) return { code: "WAITING_EXIT_NOT_ALLOWED" };
  if (!report.message?.trim()) return { code: "WAITING_MESSAGE_REQUIRED" };
  return undefined;
}
/** Waiting fingerprints keep their original null worker-target fields, so retries of waiting
 * reports accepted before those report arguments were removed still match. */
function reportFingerprint(report: RuntimeReport) {
  return fingerprint(
    JSON.stringify({
      status: report.status,
      exit: report.exit ?? null,
      message: report.message ?? null,
      ...(report.status === "waiting" ? { waitingFor: null, workerExecutionId: null } : {}),
    }),
  );
}
export function openRunnerReports(
  database: RunnerDatabase,
  lifecycle: RunnerLifecycle,
  t3: T3Adapter,
) {
  const { serial, transaction, owner } = database;
  const { isClosed, drive } = lifecycle;
  /** The report must come from the saved thread of a persisted Run under this owner and context. */
  function reportCaller(sql: SqlClient.SqlClient, binding: RuntimeBinding, retryOnly: boolean) {
    return Effect.gen(function* () {
      const [runRow] =
        yield* sql<ReportRunRow>`SELECT r.id,r.gate_open,r.closed_at,r.context_id,r.workspace_root,s.snapshot_json,o.token,c.endpoint,c.environment_id,p.project_id AS t3_project_id FROM runs r JOIN run_snapshots s ON s.run_id=r.id JOIN runner_owner o ON o.singleton=1 JOIN t3_authorization_contexts c ON c.id=r.context_id JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id WHERE r.id=${binding.factoryRunId}`;
      if (!runRow) return rejected(retryOnly ? "STALE_EXECUTION" : "RUNNER_UNAVAILABLE");
      const [connection] = yield* sql<{
        context_id: string;
      }>`SELECT context_id FROM t3_connection WHERE singleton=1`;
      if (runRow.context_id !== binding.contextId || connection?.context_id !== binding.contextId)
        return rejected("UNBOUND_CALLER");
      const [block] =
        yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${binding.factoryRunId} AND block_id=${binding.blockId}`;
      if (!block || block.thread_id !== binding.threadId) return rejected("UNBOUND_CALLER");
      if (
        binding.environmentId !== runRow.environment_id ||
        binding.workspaceRoot !== runRow.workspace_root ||
        binding.projectId !== runRow.t3_project_id ||
        binding.endpoint !== runRow.endpoint
      )
        return rejected("UNBOUND_CALLER");
      if (runRow.token !== owner.token) return rejected("RUNNER_UNAVAILABLE");
      return { ok: true as const, runRow, block };
    });
  }
  // All outgoing intents/events commit with acceptance, before dispatch or acknowledgement.
  function acceptReport(
    sql: SqlClient.SqlClient,
    runRow: ReportRunRow,
    block: BlockRow,
    binding: RuntimeBinding,
    report: RuntimeReport,
    content: string,
    route: {
      exitId: string | null;
      recipients: readonly string[];
    },
  ) {
    return Effect.gen(function* () {
      const id = yield* newId,
        time = yield* now;
      const state =
        block.problem === "execution-failed"
          ? block.state
          : block.engine_status !== "completed"
            ? "working"
            : report.status;
      const reply = acceptedTransition(
        {
          code: "ACCEPTED",
          reportId: id,
          blockId: binding.blockId,
          executionId: binding.runId,
          acceptedAt: time,
        },
        report.status,
        state,
      );
      const recipients = JSON.stringify(route.recipients);
      yield* sql`INSERT INTO runtime_reports(id,run_id,block_id,execution_id,report_key,fingerprint,status,exit_id,recipients_json,pending_message,acknowledgement_json,accepted_at,final_contract) VALUES(${id},${binding.factoryRunId},${binding.blockId},${binding.runId},${report.key},${content},${report.status},${route.exitId},${recipients},${route.recipients.length ? (report.message ?? "") : null},${JSON.stringify(reply)},${time},${report.status === "finished" ? 1 : 0})`;
      yield* sql`UPDATE runtime_reports SET activation_id=(SELECT activation_id AS id FROM run_executions WHERE run_id=${binding.factoryRunId} AND thread_id=${binding.threadId} AND execution_id=${binding.runId}),result_message=${report.message ?? null} WHERE id=${id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${binding.factoryRunId},${binding.blockId},${binding.runId},'report-accepted',${"report:" + id},${id},${time})`;
      yield* createHandoffs(sql, runRow, {
        id,
        block_id: binding.blockId,
        exit_id: route.exitId,
        recipients_json: recipients,
        pending_message: report.message ?? "",
        accepted_at: time,
      });
      yield* sql`UPDATE run_executions SET report_status=${report.status},problem=CASE WHEN problem='missing-report' THEN NULL ELSE problem END WHERE run_id=${binding.factoryRunId} AND thread_id=${binding.threadId} AND execution_id=${binding.runId}`;
      // An explicit report cannot erase an engine failure.
      yield* sql`UPDATE run_blocks SET report_status=${report.status},state=${state},problem=CASE WHEN problem='missing-report' THEN NULL ELSE problem END WHERE run_id=${binding.factoryRunId} AND block_id=${binding.blockId}`;
      yield* attention(
        sql,
        { id: binding.factoryRunId },
        block,
        binding.runId,
        "missing-report",
        false,
        time,
      );
      yield* settleCoordinatorReports(sql, binding.factoryRunId, binding.blockId, time);
      yield* settleCoordinatorWaits(sql, binding.factoryRunId, binding.blockId, time, true);
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${binding.factoryRunId}`;
      return reply;
    });
  }
  function consumeRuntimeReport(binding: RuntimeBinding, report: RuntimeReport, retryOnly = false) {
    if (isClosed()) return Effect.succeed({ code: "RUNNER_UNAVAILABLE" });
    return Effect.gen(function* () {
      const checkpoint =
        report.status === "finished" ? yield* prepareCheckpoint(database, t3, binding) : null;
      return yield* serial(binding.factoryRunId, () => {
        return Effect.gen(function* () {
          let acceptedNew = false;
          const verdict = yield* transaction((sql) =>
            Effect.gen(function* () {
              const caller = yield* reportCaller(sql, binding, retryOnly);
              if (!caller.ok) return caller.reply;
              const { runRow, block } = caller;
              const protocol = waitingRejection(report);
              if (protocol) return protocol;
              const content = reportFingerprint(report);
              const rejection = yield* workerReport(sql, binding, report, content);
              if (rejection) return rejection;
              const priorReply = yield* reportRetry(sql, binding, report.key, content);
              if (priorReply) return priorReply;
              if (!runRow.gate_open || runRow.closed_at) return { code: "RUN_CLOSED" };
              if (retryOnly || block.execution_id !== binding.runId)
                return { code: "STALE_EXECUTION" };
              if (block.freshness !== "fresh") return { code: "INCOMPLETE_EXECUTION_EVIDENCE" };
              const route = reportRoute(
                JSON.parse(runRow.snapshot_json) as RunSnapshot,
                binding.blockId,
                report,
              );
              if (!route.ok) return route.reply;
              if (report.status === "waiting")
                return yield* acceptCoordinatorWait(sql, binding, report, content);
              const checkpointError = yield* checkpointRejection(sql, checkpoint);
              if (checkpointError) return checkpointError;
              const reply = yield* acceptReport(
                sql,
                runRow,
                block,
                binding,
                report,
                content,
                route,
              );
              yield* persistCheckpoint(sql, binding, reply.reportId, checkpoint);
              acceptedNew = true;
              return reply;
            }),
          );
          if (acceptedNew && !isClosed())
            yield* lifecycle.fork(drive(binding.factoryRunId, "dispatch"));
          return verdict;
        });
      });
    });
  }
  return { consumeRuntimeReport };
}

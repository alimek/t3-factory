import { recordReportVerdict } from "./runner-report-diagnostics.ts";
import { repeatedReport, settleForReport } from "./block-report.ts";
import { newId } from "./ids.ts";
import type { RunDefinitions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunnerDatabase } from "./runner-database.ts";
import { createHandoffs } from "./runner-handoffs.ts";
import type { BlockRow, ReportRunRow, RunnerLifecycle } from "./runner-types.ts";
import { fingerprint, rejected } from "./runner-utils.ts";
import {
  acceptedTransition,
  RUN_ARCHIVED,
  type RuntimeReply,
  type RuntimeReport,
} from "./runtime-types.ts";
import { resolveBlock } from "./runtime-block-id.ts";
import { now } from "./time.ts";
import { readRunDefinitions } from "./run-definitions.ts";
import { returnToActive } from "./runner-settle.ts";
import { acceptWorking } from "./working-report.ts";

/** Exact exit names and identities resolve against the captured Flow, never a later edit. */
function reportRoute(definitions: RunDefinitions, blockId: string, report: RuntimeReport) {
  const block = definitions.flow.graph.blocks.find((block) => block.id === blockId);
  if (!block || block.kind !== "agent") return rejected("UNKNOWN_BLOCK");
  const matches = block.exits.filter(
    (candidate) => candidate.name === report.exit || candidate.id === report.exit,
  );
  const exit = matches[0];
  if (report.status === "finished" && matches.length !== 1)
    return {
      ok: false as const,
      reply: { code: "INVALID_EXIT", allowedExits: block.exits.map((exit) => exit.name) },
    };
  if (exit?.requiresFeedback && !report.message?.trim()) return rejected("FEEDBACK_REQUIRED");
  const recipients = exit
    ? definitions.flow.graph.connections
        .filter((edge) => edge.sourceBlockId === block.id && edge.exitId === exit.id)
        .map((edge) => edge.targetBlockId)
    : [];
  if (recipients.some((id) => !definitions.flow.graph.blocks.some((block) => block.id === id)))
    return rejected("INVALID_RECIPIENT");
  return { ok: true as const, exitId: exit?.id ?? null, recipients };
}
/** Held handoffs of the activation's earlier results are cancelled, so only the newest result is
 * handed off. After a release, only a different exit hands off again; Blocks started from the
 * released result keep running. */
function replaceHeldResults(
  sql: SqlClient.SqlClient,
  runId: string,
  activationId: string,
  exitId: string | null,
  time: string,
) {
  return Effect.gen(function* () {
    yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,reconciled_at=${time} WHERE run_id=${runId} AND kind='handoff' AND state='pending' AND report_id IN (SELECT r.id FROM runtime_reports r WHERE r.activation_id=${activationId} AND NOT EXISTS(SELECT 1 FROM result_releases x WHERE x.report_id=r.id))`;
    const [released] = yield* sql<{
      exit_id: string | null;
    }>`SELECT r.exit_id FROM result_releases x JOIN runtime_reports r ON r.id=x.report_id WHERE x.activation_id=${activationId} ORDER BY r.rowid DESC LIMIT 1`;
    return !released || released.exit_id !== exitId;
  });
}
/** A working report is non-final: it never selects an exit and must carry a message. */
function nonFinalRejection(report: RuntimeReport) {
  if (report.status === "finished") return undefined;
  if (report.exit !== undefined) return { code: "EXIT_NOT_ALLOWED" };
  if (!report.message?.trim()) return { code: "MESSAGE_REQUIRED" };
  return undefined;
}
function reportFingerprint(report: RuntimeReport) {
  return fingerprint(
    JSON.stringify({
      status: report.status,
      exit: report.exit ?? null,
      message: report.message ?? null,
    }),
  );
}
/** The Block a Block id names, its Run under this owner, and its current activation. */
export type ReportTarget = {
  readonly runRow: ReportRunRow;
  readonly block: BlockRow;
  readonly activationId: string;
};
export function openRunnerReports(database: RunnerDatabase, lifecycle: RunnerLifecycle) {
  const { serial, transaction, owner } = database;
  function reportTarget(sql: SqlClient.SqlClient, publicId: string) {
    return Effect.gen(function* () {
      const block = yield* resolveBlock(sql, publicId);
      if (!block) return rejected("UNKNOWN_BLOCK");
      const [saved] = yield* sql<
        Omit<ReportRunRow, "definitions"> & { flow_revision_id: string }
      >`SELECT r.id,r.gate_open,r.archived_at,r.context_id,r.workspace_root,r.flow_revision_id,o.token,c.endpoint,c.environment_id,p.project_id AS t3_project_id FROM runs r JOIN runner_owner o ON o.singleton=1 JOIN t3_authorization_contexts c ON c.id=r.context_id JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id WHERE r.id=${block.run_id}`;
      if (!saved || saved.token !== owner.token) return rejected("RUNNER_UNAVAILABLE");
      const [activation] = yield* sql<{
        id: string;
      }>`SELECT id FROM run_activations WHERE run_id=${block.run_id} AND block_id=${block.block_id} ORDER BY rowid DESC LIMIT 1`;
      if (!activation) return rejected("UNKNOWN_BLOCK");
      const runRow: ReportRunRow = { ...saved, definitions: yield* readRunDefinitions(sql, saved) };
      return { ok: true as const, target: { runRow, block, activationId: activation.id } };
    });
  }
  // All outgoing intents/events commit with acceptance, before dispatch or acknowledgement.
  function acceptReport(
    sql: SqlClient.SqlClient,
    target: ReportTarget,
    report: RuntimeReport,
    content: string,
    route: {
      exitId: string | null;
      recipients: readonly string[];
    },
  ) {
    const { runRow, block, activationId } = target;
    return Effect.gen(function* () {
      const id = yield* newId,
        time = yield* now;
      const state = block.engine_status !== "completed" ? "working" : report.status;
      const reply = acceptedTransition(
        { code: "ACCEPTED", reportId: id, acceptedAt: time },
        report.status,
        state,
      );
      const recipients = JSON.stringify(route.recipients);
      yield* settleForReport(sql, target, time, report.status);
      const handsOff = yield* replaceHeldResults(sql, runRow.id, activationId, route.exitId, time);
      yield* sql`INSERT INTO runtime_reports(id,run_id,block_id,execution_id,fingerprint,status,exit_id,recipients_json,pending_message,acknowledgement_json,accepted_at,activation_id,result_message,settles_thread) VALUES(${id},${runRow.id},${block.block_id},${block.execution_id},${content},${report.status},${route.exitId},${recipients},${handsOff && route.recipients.length ? (report.message ?? "") : null},${JSON.stringify(reply)},${time},${activationId},${report.message ?? null},1)`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${block.execution_id},'report-accepted',${"report:" + id},${id},${time})`;
      if (handsOff)
        yield* createHandoffs(sql, runRow, {
          id,
          block_id: block.block_id,
          exit_id: route.exitId,
          recipients_json: recipients,
          pending_message: report.message ?? "",
          accepted_at: time,
        });
      yield* sql`UPDATE run_blocks SET report_status=${report.status},state=${state},problem=NULL WHERE run_id=${runRow.id} AND block_id=${block.block_id}`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
      return reply;
    });
  }
  /** One verdict for the Block's current activation: the latest report is its current state, so a
   * newer finished report replaces the result. */
  function decide(sql: SqlClient.SqlClient, target: ReportTarget, report: RuntimeReport) {
    return Effect.gen(function* (): Effect.fn.Return<RuntimeReply, unknown> {
      const { runRow, block } = target;
      if (runRow.archived_at) return RUN_ARCHIVED;
      const protocol = nonFinalRejection(report);
      if (protocol) return protocol;
      const content = reportFingerprint(report);
      const repeated = yield* repeatedReport(sql, target, content);
      if (repeated) return repeated;
      const route = reportRoute(runRow.definitions, block.block_id, report);
      if (!route.ok) return route.reply;
      if (report.status === "working") return yield* acceptWorking(sql, target, report, content);
      return yield* acceptReport(sql, target, report, content, route);
    });
  }
  function consumeBlockUpdate(publicId: string, report: RuntimeReport) {
    if (lifecycle.isClosed()) return Effect.succeed<RuntimeReply>({ code: "RUNNER_UNAVAILABLE" });
    return Effect.gen(function* () {
      const located = yield* transaction((sql) => resolveBlock(sql, publicId));
      if (!located) return { code: "UNKNOWN_BLOCK" };
      // The report belongs to the thread's current turn, which T3 may not have shown Factory yet.
      const run = yield* database.row(located.run_id);
      if (run?.gate_open) yield* lifecycle.drive(run.id, "observe");
      return yield* serial(located.run_id, () =>
        Effect.gen(function* () {
          const verdict = yield* transaction((sql) =>
            Effect.gen(function* () {
              const found = yield* reportTarget(sql, publicId);
              if (!found.ok) return found.reply;
              const reply = yield* decide(sql, found.target, report);
              if (reply.code === "ACCEPTED")
                yield* returnToActive(
                  sql,
                  found.target.runRow.id,
                  found.target.block.block_id,
                  reply.reportId,
                );
              return yield* recordReportVerdict(sql, found.target, reply);
            }),
          );
          // Rejected reports may also have committed diagnostics.
          database.changes.runChanged(located.run_id);
          if (report.status === "finished" && verdict.code === "ACCEPTED" && !lifecycle.isClosed())
            yield* lifecycle.fork(lifecycle.drive(located.run_id, "dispatch"));
          return verdict;
        }),
      );
    });
  }
  return { consumeBlockUpdate };
}

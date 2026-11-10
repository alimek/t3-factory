import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import {
  nonFinalRejection,
  reportedState,
  reportFingerprint,
  reportRoute,
} from "../report-rules.ts";
import { readRunDefinitions } from "./run-definitions.ts";
import type { ReportRunRow } from "../runner-types.ts";
import { rejected } from "../runner-utils.ts";
import { resolveBlock, writeBlockState } from "./blocks.ts";
import {
  acceptedTransition,
  RUN_ARCHIVED,
  type RuntimeReply,
  type RuntimeReport,
} from "../../runtime-types.ts";
import { now } from "../../time.ts";
import { repeatedReport, settleForReport } from "./current-report.ts";
import { createHandoffs, resultProvenance } from "./handoffs.ts";
import type { ReportTarget } from "./records.ts";
import { recordReportVerdict } from "./report-diagnostics.ts";
import type { RunnerDatabase } from "./database.ts";
import { returnToActive } from "./settlement.ts";
import type { BlockState } from "./states.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";
import { acceptWorking } from "./working-report.ts";

const working: BlockState = "working";

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

/** The report's target under this owner. Its owner check is the transition's guard: an Archived
 * Run is answered by the verdict, and no authorization context or gate is required. */
function reportTarget(sql: SqlClient.SqlClient, ownerToken: string, publicId: string) {
  return Effect.gen(function* () {
    const block = yield* resolveBlock(sql, publicId);
    if (!block) return rejected("UNKNOWN_BLOCK");
    const [saved] = yield* sql<
      Omit<ReportRunRow, "definitions"> & { flow_revision_id: string }
    >`SELECT r.id,r.gate_open,r.archived_at,r.context_id,r.workspace_root,r.flow_revision_id,o.token,c.endpoint,c.environment_id,p.project_id AS t3_project_id FROM runs r JOIN runner_owner o ON o.singleton=1 JOIN t3_authorization_contexts c ON c.id=r.context_id JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id WHERE r.id=${block.run_id}`;
    if (!saved || saved.token !== ownerToken) return rejected("RUNNER_UNAVAILABLE");
    const [activation] = yield* sql<{
      id: string;
    }>`SELECT id FROM run_activations WHERE run_id=${block.run_id} AND block_id=${block.block_id} ORDER BY rowid DESC LIMIT 1`;
    if (!activation) return rejected("UNKNOWN_BLOCK");
    const runRow: ReportRunRow = { ...saved, definitions: yield* readRunDefinitions(sql, saved) };
    return { ok: true as const, target: { runRow, block, activationId: activation.id } };
  });
}

/** A new Final result version. All its held Handoffs and events commit with acceptance, before
 * dispatch or acknowledgement. */
function acceptFinal(
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
    const written = reportedState(
      runRow.definitions,
      block.block_id,
      block.engine_status !== "completed" ? working : report.status,
    );
    const state: BlockState = typeof written === "string" ? written : written.otherwise;
    const reply = acceptedTransition(
      { code: "ACCEPTED", reportId: id, acceptedAt: time },
      report.status,
      state,
    );
    const recipients = JSON.stringify(route.recipients);
    yield* settleForReport(sql, target, time, report.status);
    const handsOff = yield* replaceHeldResults(sql, runRow.id, activationId, route.exitId, time);
    yield* sql`INSERT INTO runtime_reports(id,run_id,block_id,execution_id,fingerprint,status,exit_id,recipients_json,pending_message,acknowledgement_json,accepted_at,activation_id,result_message) VALUES(${id},${runRow.id},${block.block_id},${block.execution_id},${content},${report.status},${route.exitId},${recipients},${handsOff && route.recipients.length ? (report.message ?? "") : null},${JSON.stringify(reply)},${time},${activationId},${report.message ?? null})`;
    yield* appendTimelineEvent(sql, {
      kind: "report-accepted",
      runId: runRow.id,
      blockId: block.block_id,
      executionId: block.execution_id,
      reportId: id,
      observedAt: time,
    });
    if (handsOff)
      yield* createHandoffs(sql, runRow, {
        kind: "report",
        id,
        blockId: block.block_id,
        exitId: route.exitId,
        recipients: route.recipients,
        message: report.message ?? "",
        at: time,
        origin: yield* resultProvenance(sql, activationId),
      });
    yield* writeBlockState(sql, { runId: runRow.id, blockId: block.block_id }, written, {
      report_status: report.status,
      problem: null,
    });
    yield* advanceGeneration(sql, runRow.id);
    return reply;
  });
}

/** One verdict for the Block's current activation, in this order: an Archived Run, a protocol
 * violation, a repeat of the current report, then exit resolution and acceptance. The latest
 * report is the activation's current state, so a newer finished report replaces the result. */
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
    return yield* acceptFinal(sql, target, report, content, route);
  });
}

export function openRunReports(database: RunnerDatabase) {
  /** The Block a Block id names, read before its report is accepted. */
  const locateBlock = (publicId: string) =>
    database.transaction((sql) => resolveBlock(sql, publicId));

  /** Accepts a report for the Block `publicId` names in Run `runId`. Guards: this backend owns
   * the database (otherwise RUNNER_UNAVAILABLE); an Archived Run is acknowledged without change.
   * An accepted report advances the generation, and again when it returns a Settled Run to
   * Active; a newly raised rejection diagnostic advances it once. The verdict, whatever it is, is
   * published after the commit, because a rejection may record a diagnostic. */
  function acceptReport(runId: string, publicId: string, report: RuntimeReport) {
    return database.mutate(runId, (sql) =>
      Effect.gen(function* () {
        const found = yield* reportTarget(sql, database.owner.token, publicId);
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
  }

  return { locateBlock, acceptReport };
}

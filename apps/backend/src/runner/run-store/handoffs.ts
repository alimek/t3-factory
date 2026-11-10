import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import type { RunRow } from "../../runner-types.ts";
import { fingerprint, runTarget } from "../../runner-utils.ts";
import type { ResultRecord } from "./records.ts";
import { appendTimelineEvent } from "./steps.ts";

/** One held Handoff per recipient of an accepted Final result or Human answer, deduplicated by its
 * cause. A Final result's Handoffs take its pending message, which the result then no longer
 * holds. */
export function createHeldHandoffs(
  sql: SqlClient.SqlClient,
  runRow: Pick<
    RunRow,
    "id" | "context_id" | "endpoint" | "environment_id" | "t3_project_id" | "workspace_root"
  >,
  source: Pick<
    ResultRecord,
    "id" | "block_id" | "exit_id" | "recipients_json" | "pending_message" | "accepted_at"
  >,
  occurrenceId: string | null = null,
) {
  return Effect.gen(function* () {
    for (const blockId of JSON.parse(source.recipients_json) as string[]) {
      const id = yield* newId,
        cause = `${occurrenceId ? "human" : "report"}:${source.id}/recipient:${blockId}`;
      const payload = JSON.stringify({ message: source.pending_message ?? "" });
      const inserted =
        yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,report_id,source_block_id,exit_id,occurrence_id)
          VALUES(${id},${runRow.id},${blockId},'handoff',${cause},${JSON.stringify({ ...runTarget(runRow), blockId })},${fingerprint(cause)},${payload},${fingerprint(payload)},${runRow.context_id},${occurrenceId ? null : source.id},${source.block_id},${source.exit_id},${occurrenceId}) ON CONFLICT(run_id,cause) DO NOTHING RETURNING id`;
      if (inserted.length)
        yield* appendTimelineEvent(sql, {
          kind: occurrenceId ? "handoff-created" : "handoff-held",
          runId: runRow.id,
          blockId,
          cause,
          intentId: id,
          observedAt: source.accepted_at,
        });
    }
    if (!occurrenceId)
      yield* sql`UPDATE runtime_reports SET pending_message=NULL WHERE id=${source.id}`;
  });
}

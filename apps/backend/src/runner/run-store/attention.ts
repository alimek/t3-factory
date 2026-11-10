import type { RunAttention } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import { appendTimelineEvent } from "./steps.ts";

/** A pending attention matter to settle, with the work period its settlement is recorded for. */
type PendingMatter = {
  readonly id: string;
  readonly runId: string;
  readonly blockId: string;
  readonly executionId: string;
  readonly bindingId?: string;
};

/** Settles pending matters with one reason, keeping their history on the Run timeline. */
export function settleAttention(
  sql: SqlClient.SqlClient,
  matters: readonly PendingMatter[],
  reason: string,
  time: string,
) {
  return Effect.gen(function* () {
    for (const matter of matters) {
      yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason=${reason} WHERE id=${matter.id}`;
      yield* appendTimelineEvent(sql, {
        kind: "attention-settled",
        runId: matter.runId,
        blockId: matter.blockId,
        executionId: matter.executionId,
        attentionId: matter.id,
        ...(matter.bindingId === undefined ? {} : { bindingId: matter.bindingId }),
        observedAt: time,
      });
    }
  });
}

/** Raises a present matter that is not pending and was not settled for this execution, or settles
 * the pending matters of its kind that are no longer present. A native request is one matter per
 * binding across executions. */
export function observeAttention(
  sql: SqlClient.SqlClient,
  runId: string,
  block: { readonly block_id: string; readonly bindingId?: string },
  executionId: string,
  kind: RunAttention["kind"],
  present: boolean,
  time: string,
) {
  return Effect.gen(function* () {
    const pending = yield* sql<{
      id: string;
    }>`SELECT id FROM run_attention WHERE run_id=${runId} AND block_id=${block.block_id} AND kind=${kind} AND binding_id IS ${block.bindingId ?? null} AND settled_at IS NULL AND (${kind === "native-request" ? 1 : 0}=1 OR execution_id=${executionId})`;
    if (present && !pending.length && !(yield* settledFor(sql, runId, block, executionId, kind))) {
      const id = yield* newId;
      yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,appeared_at,binding_id) VALUES(${id},${runId},${block.block_id},${executionId},${kind},${"attention:" + id},${time},${block.bindingId ?? null})`;
      yield* appendTimelineEvent(sql, {
        kind: "attention-appeared",
        runId,
        blockId: block.block_id,
        executionId,
        attentionId: id,
        observedAt: time,
      });
    } else if (!present)
      yield* settleAttention(
        sql,
        pending.map((entry) => ({ id: entry.id, runId, blockId: block.block_id, executionId })),
        kind === "native-request" ? "withdrawn" : "completed",
        time,
      );
  });
}

/** A settled execution failure, or a missing report its recovery settled, is not raised again for
 * the same execution; a new failed run is a new matter. */
function settledFor(
  sql: SqlClient.SqlClient,
  runId: string,
  block: { readonly block_id: string },
  executionId: string,
  kind: RunAttention["kind"],
) {
  if (kind === "execution-failed")
    return Effect.map(
      sql`SELECT id FROM run_attention WHERE run_id=${runId} AND block_id=${block.block_id} AND kind='execution-failed' AND execution_id=${executionId} AND settled_at IS NOT NULL`,
      (rows) => rows.length > 0,
    );
  if (kind === "missing-report")
    return Effect.map(
      sql`SELECT attention_id FROM report_recoveries WHERE run_id=${runId} AND block_id=${block.block_id} AND source_execution_id=${executionId} AND settled_at IS NOT NULL`,
      (rows) => rows.length > 0,
    );
  return Effect.succeed(false);
}

/** Settles every pending matter of one kind on a Block, keeping its history. */
export function settlePendingAttention(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  kind: RunAttention["kind"],
  reason: string,
  time: string,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      execution_id: string;
    }>`SELECT id,execution_id FROM run_attention WHERE run_id=${runId} AND block_id=${blockId} AND kind=${kind} AND settled_at IS NULL`;
    yield* settleAttention(
      sql,
      rows.map((row) => ({ id: row.id, runId, blockId, executionId: row.execution_id })),
      reason,
      time,
    );
  });
}

/** A Human occurrence's attention appears with it, identified by the occurrence. */
export function raiseHumanAttention(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  occurrenceId: string,
  time: string,
) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,occurrence_id,appeared_at) VALUES(${occurrenceId},${runId},${blockId},'', 'human',${"human:" + occurrenceId},${occurrenceId},${time})`;
    yield* appendTimelineEvent(sql, {
      kind: "attention-appeared",
      runId,
      blockId,
      occurrenceId,
      observedAt: time,
    });
  });
}

/** An answer settles its Human occurrence's attention; the settlement is recorded once per
 * occurrence. */
export function settleHumanAttention(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  occurrenceId: string,
  time: string,
) {
  return Effect.gen(function* () {
    yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='answered' WHERE occurrence_id=${occurrenceId} AND settled_at IS NULL`;
    yield* appendTimelineEvent(sql, {
      kind: "attention-settled",
      runId,
      blockId,
      occurrenceId,
      observedAt: time,
    });
  });
}

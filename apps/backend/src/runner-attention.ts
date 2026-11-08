import { newId } from "./ids.ts";
import { threadHref } from "./thread-link.ts";
import type { RunAttention } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { BlockRow, RunRow } from "./runner-types.ts";
export function attentionRows(sql: SqlClient.SqlClient, runId?: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      binding_id: string | null;
      run_id: string;
      title: string;
      block_id: string;
      name: string;
      execution_id: string;
      kind: RunAttention["kind"];
      native_request_id: string | null;
      occurrence_id: string | null;
      link: string | null;
      freshness: RunAttention["freshness"];
      appeared_at: string;
      settled_at: string | null;
      settlement_reason: string | null;
      message: string | null;
    }>`
      SELECT a.*,t.title,b.name,CASE WHEN a.binding_id IS NOT NULL THEN binding.link ELSE b.link END AS link,b.freshness FROM run_attention a JOIN runs r ON r.id=a.run_id
      JOIN tasks t ON t.id=r.task_id JOIN run_blocks b ON b.run_id=a.run_id AND b.block_id=a.block_id
      LEFT JOIN run_thread_bindings binding ON binding.id=a.binding_id
      WHERE (${runId ?? null} IS NULL OR a.run_id=${runId ?? null}) ORDER BY a.appeared_at DESC,a.rowid DESC`;
    return rows.map((attentionEntry) => ({
      id: attentionEntry.id,
      ...(attentionEntry.binding_id ? { bindingId: attentionEntry.binding_id } : {}),
      runId: attentionEntry.run_id,
      taskTitle: attentionEntry.title,
      blockId: attentionEntry.block_id,
      blockName: attentionEntry.name,
      executionId: attentionEntry.execution_id,
      kind: attentionEntry.kind,
      nativeRequestId: attentionEntry.native_request_id,
      occurrenceId: attentionEntry.occurrence_id,
      link: threadHref(attentionEntry.link),
      freshness: attentionEntry.freshness,
      appearedAt: attentionEntry.appeared_at,
      settledAt: attentionEntry.settled_at,
      settlementReason: attentionEntry.settlement_reason,
      message: attentionEntry.message,
    }));
  });
}
export function attention(
  sql: SqlClient.SqlClient,
  runRow: Pick<RunRow, "id">,
  block: Pick<BlockRow, "block_id"> & { bindingId?: string },
  executionId: string,
  kind: RunAttention["kind"],
  present: boolean,
  time: string,
) {
  return Effect.gen(function* () {
    const pending = yield* sql<{
      id: string;
    }>`SELECT id FROM run_attention WHERE run_id=${runRow.id} AND block_id=${block.block_id} AND kind=${kind} AND binding_id IS ${block.bindingId ?? null} AND settled_at IS NULL AND (${kind === "native-request" ? 1 : 0}=1 OR execution_id=${executionId})`;
    if (present && !pending.length && !(yield* settledFor(sql, runRow, block, executionId, kind))) {
      const id = yield* newId;
      yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,appeared_at,binding_id) VALUES(${id},${runRow.id},${block.block_id},${executionId},${kind},${"attention:" + id},${time},${block.bindingId ?? null})`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${executionId},'attention-appeared',${"attention:" + id},${id},${time})`;
    } else if (!present)
      for (const entry of pending) {
        const reason = kind === "native-request" ? "withdrawn" : "completed";
        yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason=${reason} WHERE id=${entry.id}`;
        yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${block.block_id},${executionId},'attention-settled',${"attention-settled:" + entry.id},${entry.id},${time})`;
      }
  });
}

/** A settled execution failure, or a missing report its recovery settled, is not raised again for
 * the same execution; a new failed run is a new matter. */
function settledFor(
  sql: SqlClient.SqlClient,
  runRow: Pick<RunRow, "id">,
  block: Pick<BlockRow, "block_id">,
  executionId: string,
  kind: RunAttention["kind"],
) {
  if (kind === "execution-failed")
    return Effect.map(
      sql`SELECT id FROM run_attention WHERE run_id=${runRow.id} AND block_id=${block.block_id} AND kind='execution-failed' AND execution_id=${executionId} AND settled_at IS NOT NULL`,
      (rows) => rows.length > 0,
    );
  if (kind === "missing-report")
    return Effect.map(
      sql`SELECT attention_id FROM report_recoveries WHERE run_id=${runRow.id} AND block_id=${block.block_id} AND source_execution_id=${executionId} AND settled_at IS NOT NULL`,
      (rows) => rows.length > 0,
    );
  return Effect.succeed(false);
}

/** Settles every pending matter of one kind on a Block, keeping its history. */
export function settlePending(
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
    for (const row of rows) {
      yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason=${reason} WHERE id=${row.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${runId},${blockId},${row.execution_id},'attention-settled',${"attention-settled:" + row.id},${row.id},${time})`;
    }
  });
}

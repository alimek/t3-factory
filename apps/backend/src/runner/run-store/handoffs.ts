import type { WorkerProvenance } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import { newId } from "../../ids.ts";
import type { RunRow } from "../runner-types.ts";
import { fingerprint, intactPayload, runTarget } from "../runner-utils.ts";
import { guardsHold } from "./guards.ts";
import type { DeliveryRecord, Handoff } from "./records.ts";
import { appendTimelineEvent } from "./steps.ts";

/**
 * A delivery's stored worker provenance: the thread binding a Continuation continues and, when
 * known, the Block activation whose result the message is. It is stored on every Handoff and kept
 * when the Handoff becomes a delivery, reaches a Wait, passes through or reaches a Human step,
 * whose answer forwards it.
 */
export type StoredProvenance = {
  readonly bindingId: string;
  readonly activationId: string | null;
};

/** The provenance a stored delivery or Wait arrival carries, if any. */
export const storedProvenance = (row: {
  readonly binding_id: string | null;
  readonly origin_activation_id: string | null;
}): StoredProvenance | null =>
  row.binding_id ? { bindingId: row.binding_id, activationId: row.origin_activation_id } : null;

/** The provenance Run detail shows for a stored delivery or Wait arrival, read with its binding's
 * thread: present only when both thread and activation are known. */
export const workerProvenance = (row: {
  readonly run_id: string;
  readonly origin_activation_id: string | null;
  readonly origin_thread_id: string | null;
}): WorkerProvenance | null =>
  row.origin_activation_id && row.origin_thread_id
    ? { runId: row.run_id, activationId: row.origin_activation_id, threadId: row.origin_thread_id }
    : null;

/**
 * The Handoffs a Final result version, a Human answer or a Wait arrival's forwarding creates, named
 * by that record's id. A Final result's Handoffs stay held until its release; the others are
 * released when created.
 */
export type OutgoingHandoffs = {
  readonly kind: "report" | "human" | "wait";
  readonly id: string;
  readonly blockId: string;
  readonly exitId: string | null;
  readonly recipients: readonly string[];
  readonly message: string;
  readonly at: string;
  readonly origin: StoredProvenance | null;
};

/** SQL for the thread binding a result of activation `activation` (a SQL expression) belongs to:
 * the thread a Continuation's prompt ran on, else its Block's worker; null without a worker. */
export const resultBinding = (sql: SqlClient.SqlClient, activation: Fragment) =>
  sql`COALESCE((SELECT v.binding_id FROM continuation_visits v WHERE v.activation_id=${activation}),(SELECT t.id FROM run_activations a JOIN run_blocks b ON b.run_id=a.run_id AND b.block_id=a.block_id JOIN run_thread_bindings t ON t.run_id=b.run_id AND t.thread_id=b.thread_id WHERE a.id=${activation}))`;

/** The provenance of a result of `activationId`; none without a worker thread. */
export function resultProvenance(sql: SqlClient.SqlClient, activationId: string) {
  return Effect.map(
    sql<{
      binding_id: string | null;
    }>`SELECT ${resultBinding(sql, sql`${activationId}`)} AS binding_id`,
    ([row]): StoredProvenance | null =>
      row?.binding_id ? { bindingId: row.binding_id, activationId } : null,
  );
}

/** One Handoff per recipient of `source`, deduplicated by its cause. A Final result's Handoffs
 * take its pending message, which the result then no longer holds. */
export function createHandoffs(
  sql: SqlClient.SqlClient,
  runRow: Pick<
    RunRow,
    "id" | "context_id" | "endpoint" | "environment_id" | "t3_project_id" | "workspace_root"
  >,
  source: OutgoingHandoffs,
) {
  return Effect.gen(function* () {
    const ref = (kind: OutgoingHandoffs["kind"]) => (source.kind === kind ? source.id : null);
    for (const blockId of source.recipients) {
      const id = yield* newId,
        cause = `${source.kind}:${source.id}/recipient:${blockId}`;
      const payload = JSON.stringify({ message: source.message });
      const inserted =
        yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,report_id,source_block_id,exit_id,occurrence_id,wait_arrival_id,binding_id,origin_activation_id)
          VALUES(${id},${runRow.id},${blockId},'handoff',${cause},${JSON.stringify({ ...runTarget(runRow), blockId })},${fingerprint(cause)},${payload},${fingerprint(payload)},${runRow.context_id},${ref("report")},${source.blockId},${source.exitId},${ref("human")},${ref("wait")},${source.origin?.bindingId ?? null},${source.origin?.activationId ?? null}) ON CONFLICT(run_id,cause) DO NOTHING RETURNING id`;
      if (inserted.length)
        yield* appendTimelineEvent(sql, {
          kind: source.kind === "report" ? "handoff-held" : "handoff-created",
          runId: runRow.id,
          blockId,
          cause,
          intentId: id,
          observedAt: source.at,
        });
    }
    if (source.kind === "report")
      yield* sql`UPDATE runtime_reports SET pending_message=NULL WHERE id=${source.id}`;
  });
}

/** The pending Handoff a Human occurrence or Wait arrival is recorded from, with its stored
 * message, once the guards hold: owner, open gate, the Handoff's authorization context is live and
 * `generation` (a source release the caller read), when given, holds. Undefined when a guard fails
 * or the Handoff is no longer pending; a message that cannot be verified fails. */
export function arrivingHandoff(
  sql: SqlClient.SqlClient,
  ownerToken: string,
  runId: string,
  handoff: Handoff,
  generation: number | undefined,
) {
  return Effect.gen(function* () {
    const held = yield* guardsHold(sql, ownerToken, runId, {
      owner: true,
      gateOpen: true,
      liveContext: handoff.context_id,
      ...(generation === undefined ? {} : { generation }),
    });
    const [pending] =
      yield* sql<DeliveryRecord>`SELECT * FROM operation_intents WHERE id=${handoff.id} AND state='pending'`;
    if (!held || !pending) return undefined;
    if (!intactPayload(pending)) return yield* Effect.fail(Error("Invalid arrival message"));
    return {
      record: pending,
      message: (JSON.parse(pending.payload_json) as { message: string }).message,
    };
  });
}

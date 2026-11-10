import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import type { RunRow } from "../runner-types.ts";
import { fingerprint, intactPayload, runTarget } from "../runner-utils.ts";
import { guardsHold } from "./guards.ts";
import type { DeliveryRecord, Handoff } from "./records.ts";
import { appendTimelineEvent } from "./steps.ts";

/**
 * The worker whose result a delivery carries: its Block activation and T3 thread in the Run. It is
 * stored on every Handoff and kept when the Handoff becomes a delivery or reaches a Wait.
 */
export type DeliveryOrigin = { readonly activationId: string; readonly threadId: string };

/**
 * What creates Handoffs: a Final result version, a Human answer or a Wait arrival's forwarding,
 * named by that record's id. A Final result's Handoffs stay held until its release; the others are
 * released when created.
 */
export type HandoffSource = {
  readonly kind: "report" | "human" | "wait";
  readonly id: string;
  readonly blockId: string;
  readonly exitId: string | null;
  readonly recipients: readonly string[];
  readonly message: string;
  readonly at: string;
  readonly origin: DeliveryOrigin | null;
};

/** One Handoff per recipient of `source`, deduplicated by its cause. A Final result's Handoffs
 * take its pending message, which the result then no longer holds. */
export function createHeldHandoffs(
  sql: SqlClient.SqlClient,
  runRow: Pick<
    RunRow,
    "id" | "context_id" | "endpoint" | "environment_id" | "t3_project_id" | "workspace_root"
  >,
  source: HandoffSource,
) {
  return Effect.gen(function* () {
    const ref = (kind: HandoffSource["kind"]) => (source.kind === kind ? source.id : null);
    for (const blockId of source.recipients) {
      const id = yield* newId,
        cause = `${source.kind}:${source.id}/recipient:${blockId}`;
      const payload = JSON.stringify({ message: source.message });
      const inserted =
        yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,report_id,source_block_id,exit_id,occurrence_id,wait_arrival_id,origin_activation_id,origin_thread_id)
          VALUES(${id},${runRow.id},${blockId},'handoff',${cause},${JSON.stringify({ ...runTarget(runRow), blockId })},${fingerprint(cause)},${payload},${fingerprint(payload)},${runRow.context_id},${ref("report")},${source.blockId},${source.exitId},${ref("human")},${ref("wait")},${source.origin?.activationId ?? null},${source.origin?.threadId ?? null}) ON CONFLICT(run_id,cause) DO NOTHING RETURNING id`;
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

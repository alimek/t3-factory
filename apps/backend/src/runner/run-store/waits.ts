import { WAIT_EXIT, waitDurationMinutes } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import { now } from "../../time.ts";
import type { RunRow, StoredTarget } from "../runner-types.ts";
import { fingerprint, intactPayload } from "../runner-utils.ts";
import { writeBlockState } from "./blocks.ts";
import type { RunnerDatabase } from "./database.ts";
import { readRunRow } from "./database.ts";
import { guardsHold, pendingHandoffHolds } from "./guards.ts";
import type { Handoff } from "./records.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** Why a pending arrival is forwarded: elapsed deadline or an early user action. */
type WaitForwardReason = "elapsed" | "early";

/**
 * What a forwarding attempt found: it forwarded the arrival now; another attempt already forwarded
 * it; the arrival is cancelled or the Run's owner or open gate does not hold; or, for `elapsed`,
 * the deadline has not passed.
 */
type WaitForwarding = "forwarded" | "already-forwarded" | "refused" | "not-due";

type ArrivalRow = {
  id: string;
  run_id: string;
  block_id: string;
  incoming_intent_id: string;
  binding_id: string | null;
  origin_activation_id: string | null;
  message: string | null;
  state: "pending" | "forwarded" | "cancelled";
  deadline_at: string;
};

/** A pending arrival and when it is due, which Factory's wake-up timer sleeps until. */
type PendingWait = {
  readonly id: string;
  readonly run_id: string;
  readonly deadline_at: string;
};

/** The Final result version whose message reached the Wait: the Handoff's own, or for a message an
 * earlier Wait forwarded (cause `wait:`), the one that earlier arrival carried. */
function arrivalReport(sql: SqlClient.SqlClient, handoff: Handoff) {
  if (handoff.report_id) return Effect.succeed(handoff.report_id);
  const forwardedFrom = /^wait:([^/]+)/.exec(handoff.cause)?.[1];
  if (!forwardedFrom) return Effect.succeed(null);
  return Effect.map(
    sql<{
      report_id: string | null;
    }>`SELECT report_id FROM wait_arrivals WHERE id=${forwardedFrom}`,
    ([earlier]) => earlier?.report_id ?? null,
  );
}

/** One released Handoff per recipient of the Wait's output, each with the arrival's message and
 * origin; a pass-through cause makes them released, as a Continuation's pass-through is. */
function forwardToRecipients(
  sql: SqlClient.SqlClient,
  run: RunRow,
  arrival: ArrivalRow,
  target: StoredTarget,
  time: string,
) {
  return Effect.gen(function* () {
    const recipients = [
      ...new Set(
        run.definitions.flow.graph.connections
          .filter((edge) => edge.sourceBlockId === arrival.block_id && edge.exitId === WAIT_EXIT.id)
          .map((edge) => edge.targetBlockId),
      ),
    ];
    const payload = JSON.stringify({ message: arrival.message ?? "" });
    for (const blockId of recipients) {
      const id = yield* newId,
        cause = `wait:${arrival.id}/recipient:${blockId}`;
      const inserted =
        yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,source_block_id,exit_id,binding_id,origin_activation_id)
          VALUES(${id},${run.id},${blockId},'handoff',${cause},${JSON.stringify({ ...target, blockId })},${fingerprint(cause)},${payload},${fingerprint(payload)},${run.context_id},${arrival.block_id},${WAIT_EXIT.id},${arrival.binding_id},${arrival.origin_activation_id}) ON CONFLICT(run_id,cause) DO NOTHING RETURNING id`;
      if (inserted.length)
        yield* appendTimelineEvent(sql, {
          kind: "handoff-created",
          runId: run.id,
          blockId,
          cause,
          intentId: id,
          observedAt: time,
        });
    }
  });
}

/**
 * Wait arrivals. Every Handoff released to a Wait becomes one arrival that keeps the message and
 * its origin until a deadline counted from that release; forwarding is one guarded transition.
 */
export function openRunWaits(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** Turns a released Handoff to a Wait into a pending arrival due after the Wait's captured
   * duration. `current` is the snapshot the caller read the release at. Guards: owner, not
   * Archived, live authorization context, open gate and `current`'s generation; the Handoff is
   * still pending, so a repeated attempt records nothing. Acknowledges the Handoff, moving its
   * message to the arrival, sets the Wait waiting, appends "wait started" and advances the
   * generation. Answers the arrival recorded, if any. */
  function handoffToWaitArrival(current: RunRow, handoff: Handoff) {
    return database.mutate(current.id, (sql) =>
      Effect.gen(function* (): Effect.fn.Return<PendingWait | undefined, unknown> {
        if (!(yield* pendingHandoffHolds(sql, ownerToken, current, handoff.id))) return undefined;
        if (!intactPayload(handoff)) throw Error("Invalid handoff payload");
        const block = current.definitions.flow.graph.blocks.find(
          (entry) => entry.id === handoff.block_id,
        );
        // Start admits only ready Flows, whose Waits have a duration in range.
        const duration = block?.kind === "wait" ? waitDurationMinutes(block.duration) : null;
        if (duration === null) throw Error("Arrival target is not a ready Wait");
        const message = (JSON.parse(handoff.payload_json) as { message: string }).message;
        const id = yield* newId,
          time = yield* now;
        const deadline = new Date(Date.parse(time) + duration * 60_000).toISOString();
        yield* sql`INSERT INTO wait_arrivals(id,run_id,block_id,incoming_intent_id,source_block_id,report_id,binding_id,origin_activation_id,message,state,started_at,deadline_at)
          VALUES(${id},${current.id},${handoff.block_id},${handoff.id},${handoff.source_block_id},${yield* arrivalReport(sql, handoff)},${handoff.binding_id},${handoff.origin_activation_id},${message},'pending',${time},${deadline})`;
        yield* sql`UPDATE operation_intents SET state='acknowledged',payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${handoff.id}`;
        yield* writeBlockState(sql, { runId: current.id, blockId: handoff.block_id }, "waiting", {
          freshness: "fresh",
          observed_at: time,
        });
        yield* appendTimelineEvent(sql, {
          kind: "wait-started",
          runId: current.id,
          blockId: handoff.block_id,
          arrivalId: id,
          observedAt: time,
        });
        yield* advanceGeneration(sql, current.id);
        return { id, run_id: current.id, deadline_at: deadline };
      }),
    );
  }

  /**
   * The one forwarding transition for a Wait arrival. It claims the pending arrival, records its
   * outcome and creates a released Handoff for every recipient of the Wait's output in one
   * transaction, so a message is neither lost between its timer and its Handoffs nor forwarded
   * twice. Guards: owner, not Archived and open gate; the arrival is pending and, for `elapsed`,
   * due. No live authorization context is required: the downstream deliveries keep their own
   * guards. Clears the retained message, keeps the Wait waiting while another arrival is pending
   * and finished otherwise, appends the outcome and advances the generation. Only a forwarding
   * is published.
   */
  function forwardWaitArrival(arrivalId: string, reason: WaitForwardReason) {
    return Effect.gen(function* (): Effect.fn.Return<
      { outcome: WaitForwarding; runId: string | null },
      unknown
    > {
      const [found] = yield* database.transaction(
        (sql) => sql<{ run_id: string }>`SELECT run_id FROM wait_arrivals WHERE id=${arrivalId}`,
      );
      if (!found) return { outcome: "refused", runId: null };
      return yield* database.mutate(
        found.run_id,
        (sql) =>
          Effect.gen(function* (): Effect.fn.Return<
            { outcome: WaitForwarding; runId: string | null },
            unknown
          > {
            const [arrival] =
              yield* sql<ArrivalRow>`SELECT * FROM wait_arrivals WHERE id=${arrivalId}`;
            if (arrival?.state === "forwarded")
              return { outcome: "already-forwarded", runId: found.run_id };
            const held = yield* guardsHold(sql, ownerToken, found.run_id, {
              owner: true,
              notArchived: true,
              gateOpen: true,
            });
            if (!held || arrival?.state !== "pending")
              return { outcome: "refused", runId: found.run_id };
            const time = yield* now;
            if (reason === "elapsed" && arrival.deadline_at > time)
              return { outcome: "not-due", runId: found.run_id };
            const run = (yield* readRunRow(sql, found.run_id))!;
            const [incoming] = yield* sql<{
              target_json: string;
            }>`SELECT target_json FROM operation_intents WHERE id=${arrival.incoming_intent_id}`;
            yield* forwardToRecipients(
              sql,
              run,
              arrival,
              JSON.parse(incoming!.target_json) as StoredTarget,
              time,
            );
            yield* sql`UPDATE wait_arrivals SET state='forwarded',forward_reason=${reason},message=NULL,settled_at=${time} WHERE id=${arrivalId}`;
            yield* writeBlockState(
              sql,
              { runId: run.id, blockId: arrival.block_id },
              { whilePending: "waiting", otherwise: "finished" },
            );
            yield* appendTimelineEvent(sql, {
              kind: reason === "early" ? "wait-continued" : "wait-elapsed",
              runId: run.id,
              blockId: arrival.block_id,
              arrivalId,
              observedAt: time,
            });
            yield* advanceGeneration(sql, run.id);
            return { outcome: "forwarded", runId: found.run_id };
          }),
        (result) => result.outcome === "forwarded",
      );
    });
  }

  /** Pending arrivals, of one Run or every Run, earliest deadline first. */
  const pendingWaits = (runId?: string) =>
    database.transaction(
      (sql) =>
        sql<PendingWait>`SELECT id,run_id,deadline_at FROM wait_arrivals WHERE state='pending' ${runId === undefined ? sql`` : sql`AND run_id=${runId}`} ORDER BY deadline_at,rowid`,
    );

  return { handoffToWaitArrival, forwardWaitArrival, pendingWaits };
}

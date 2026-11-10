import type { WaitArrival } from "@t3-factory/contracts";
import { WAIT_OUTPUT, waitDurationMs } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import { newId } from "../../ids.ts";
import { now } from "../../time.ts";
import type { RunRow } from "../runner-types.ts";
import { writeBlockState } from "./blocks.ts";
import { readRunRow, type RunnerDatabase } from "./database.ts";
import { guardsHold } from "./guards.ts";
import { arrivingHandoff, createHeldHandoffs, storedOrigin } from "./handoffs.ts";
import type { Handoff } from "./records.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

export type WaitArrivalRow = {
  id: string;
  run_id: string;
  block_id: string;
  incoming_intent_id: string;
  state: WaitArrival["state"];
  forwarded_by: WaitArrival["forwardedBy"];
  message: string | null;
  binding_id: string | null;
  origin_activation_id: string | null;
  started_at: string;
  deadline_at: string;
  settled_at: string | null;
};

/** A pending arrival as the Runner schedules its wake-up. */
export type ScheduledWait = {
  readonly id: string;
  readonly runId: string;
  readonly deadlineAt: string;
};

/** Who forwards an arrival: its elapsed deadline. */
type WaitForwarder = NonNullable<WaitArrival["forwardedBy"]>;

/**
 * What a forwarding attempt found. Only `forwarded` changed the Run; the others leave the arrival
 * as it was: forwarded or cancelled already, not yet due for the timer, or a Run that no longer
 * accepts forwarding (closed gate or another owner).
 */
type WaitForwarding =
  | "forwarded"
  | "already-forwarded"
  | "cancelled"
  | "not-due"
  | "closed"
  | "not-found";

/** The public arrival; `origin_thread_id` is its bound worker's thread. */
export function waitArrival(
  row: WaitArrivalRow & { origin_thread_id: string | null },
): WaitArrival {
  return {
    id: row.id,
    blockId: row.block_id,
    incomingIntentId: row.incoming_intent_id,
    state: row.state,
    forwardedBy: row.forwarded_by,
    message: row.message,
    origin:
      row.origin_activation_id && row.origin_thread_id
        ? {
            runId: row.run_id,
            activationId: row.origin_activation_id,
            threadId: row.origin_thread_id,
          }
        : null,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    settledAt: row.settled_at,
  };
}

const addMilliseconds = (time: string, milliseconds: number) =>
  new Date(Date.parse(time) + milliseconds).toISOString();

export function openRunWaits(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** Records a pending Handoff to a Wait as one arrival holding its message and origin. Counting
   * starts when the Handoff was released: its Final result's release, or the Human answer or Wait
   * forwarding that created it already released. The deadline is fixed here. `generation`, when
   * given, is the snapshot at which the caller read the Final result released. Guards: owner,
   * open gate, the Handoff's authorization context is live and that generation holds; the Handoff
   * is still pending, so a repeated delivery attempt records no second arrival. A Handoff whose
   * stored message cannot be verified fails the transition. Sets the Wait waiting, appends "Wait
   * started" and advances the generation. Answers the arrival to schedule. */
  function handoffToWaitArrival(runRow: RunRow, handoff: Handoff, generation: number | undefined) {
    return database.mutate(
      runRow.id,
      (sql) =>
        Effect.gen(function* (): Effect.fn.Return<ScheduledWait | undefined, unknown> {
          const arriving = yield* arrivingHandoff(sql, ownerToken, runRow.id, handoff, generation);
          if (!arriving) return undefined;
          const pending = arriving.record;
          const block = runRow.definitions.flow.graph.blocks.find(
            (entry) => entry.id === handoff.block_id,
          );
          if (block?.kind !== "wait" || !block.duration)
            return yield* Effect.fail(Error("Wait duration is missing from the captured Flow"));
          const time = yield* now;
          const [released] = yield* sql<{
            at: string | null;
          }>`SELECT COALESCE((SELECT released_at FROM result_releases WHERE report_id=${pending.report_id}),(SELECT observed_at FROM run_events WHERE run_id=${runRow.id} AND source_key=${pending.cause})) AS at`;
          const startedAt = released?.at ?? time;
          const id = yield* newId;
          const deadlineAt = addMilliseconds(startedAt, waitDurationMs(block.duration));
          yield* sql`INSERT INTO wait_arrivals(id,run_id,block_id,incoming_intent_id,message,binding_id,origin_activation_id,started_at,deadline_at) VALUES(${id},${runRow.id},${handoff.block_id},${handoff.id},${arriving.message},${pending.binding_id},${pending.origin_activation_id},${startedAt},${deadlineAt})`;
          yield* sql`UPDATE operation_intents SET state='acknowledged',payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${handoff.id}`;
          yield* writeBlockState(sql, { runId: runRow.id, blockId: handoff.block_id }, "waiting", {
            freshness: "fresh",
            observed_at: time,
          });
          yield* appendTimelineEvent(sql, {
            kind: "wait-started",
            runId: runRow.id,
            blockId: handoff.block_id,
            arrivalId: id,
            observedAt: time,
          });
          yield* advanceGeneration(sql, runRow.id);
          return { id, runId: runRow.id, deadlineAt };
        }),
      (scheduled) => scheduled !== undefined,
    );
  }

  /** Forwards pending arrival `arrivalId` of Run `runId` unchanged to every recipient of its
   * Wait's output: the one transition behind the timer and any user action that forwards. The
   * timer forwards only once the deadline passed. Guards: owner and open gate; the arrival is
   * still pending, so competing forwards produce one set of Handoffs. Atomically records the
   * outcome and creates every outgoing Handoff, released from creation and carrying the arrival's
   * message and origin; the arrival keeps its message as the input its recipients read. Sets the
   * Wait finished once no arrival is pending, appends "Wait forwarded" and advances the
   * generation. Only a forwarding is published. */
  function forwardWaitArrival(runId: string, arrivalId: string, forwardedBy: WaitForwarder) {
    return database.mutate(
      runId,
      (sql) =>
        Effect.gen(function* (): Effect.fn.Return<WaitForwarding, unknown> {
          const [arrival] =
            yield* sql<WaitArrivalRow>`SELECT * FROM wait_arrivals WHERE id=${arrivalId} AND run_id=${runId}`;
          if (!arrival) return "not-found";
          if (arrival.state === "forwarded") return "already-forwarded";
          if (arrival.state === "cancelled") return "cancelled";
          const held = yield* guardsHold(sql, ownerToken, runId, { owner: true, gateOpen: true });
          const runRow = yield* readRunRow(sql, runId);
          if (!held || !runRow) return "closed";
          const time = yield* now;
          if (forwardedBy === "timer" && arrival.deadline_at > time) return "not-due";
          const recipients = [
            ...new Set(
              runRow.definitions.flow.graph.connections
                .filter(
                  (edge) =>
                    edge.sourceBlockId === arrival.block_id && edge.exitId === WAIT_OUTPUT.id,
                )
                .map((edge) => edge.targetBlockId),
            ),
          ];
          yield* sql`UPDATE wait_arrivals SET state='forwarded',forwarded_by=${forwardedBy},settled_at=${time} WHERE id=${arrivalId} AND state='pending'`;
          yield* createHeldHandoffs(sql, runRow, {
            kind: "wait",
            id: arrivalId,
            blockId: arrival.block_id,
            exitId: WAIT_OUTPUT.id,
            recipients,
            message: arrival.message ?? "",
            at: time,
            origin: storedOrigin(arrival),
          });
          yield* writeBlockState(
            sql,
            { runId, blockId: arrival.block_id },
            { whileArrivalPending: "waiting", otherwise: "finished" },
          );
          yield* appendTimelineEvent(sql, {
            kind: "wait-forwarded",
            runId,
            blockId: arrival.block_id,
            arrivalId,
            observedAt: time,
          });
          yield* advanceGeneration(sql, runId);
          return "forwarded";
        }),
      (outcome) => outcome === "forwarded",
    );
  }

  /** The Run's pending arrivals whose deadline has passed, oldest deadline first. */
  const dueWaitArrivals = (runId: string) =>
    database.transaction((sql) =>
      Effect.gen(function* () {
        const time = yield* now;
        return yield* sql<{
          id: string;
        }>`SELECT id FROM wait_arrivals WHERE run_id=${runId} AND state='pending' AND deadline_at<=${time} ORDER BY deadline_at,rowid`;
      }),
    );

  /** Every pending arrival of a Run that is not Archived, for scheduling wake-ups at startup. */
  const pendingWaits = () =>
    database.transaction(
      (sql) =>
        sql<ScheduledWait>`SELECT w.id,w.run_id AS "runId",w.deadline_at AS "deadlineAt" FROM wait_arrivals w JOIN runs r ON r.id=w.run_id WHERE w.state='pending' AND r.archived_at IS NULL ORDER BY w.deadline_at,w.rowid`,
    );

  return { handoffToWaitArrival, forwardWaitArrival, dueWaitArrivals, pendingWaits };
}

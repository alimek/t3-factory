import { CONTINUATION_EXIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import { now } from "../../time.ts";
import type { RunRow, StoredTarget } from "../runner-types.ts";
import { fingerprint, intactPayload } from "../runner-utils.ts";
import { continuationPromptMessage, workerRevisitPayload } from "../worker-payloads.ts";
import { writeBlockState } from "./blocks.ts";
import type { RunnerDatabase } from "./database.ts";
import { asDelivery } from "./deliveries.ts";
import { guardsHold, pendingHandoffHolds } from "./guards.ts";
import type { DeliveryRecord, Handoff } from "./records.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** A Continuation's prompt visit: `sent` until its response is forwarded, then every later message
 * passes through. */
type ContinuationPrompt = {
  readonly state: "sent" | "forwarded" | "cancelled";
  readonly incoming_intent_id: string;
};

/** The Handoff's stored message, which a Continuation sends after its prompt or passes on. */
const arrivalMessage = (handoff: Handoff) => {
  if (!intactPayload(handoff)) throw Error("Invalid handoff payload");
  return (JSON.parse(handoff.payload_json) as { message: string }).message;
};

/** The block and exit that wrote a Handoff's message. A Wait forwards its arrival's message
 * unchanged, so a message from a Wait was written by that arrival's source, through consecutive
 * Waits. */
const messageAuthor = (sql: SqlClient.SqlClient, handoff: Handoff) =>
  Effect.gen(function* () {
    let author: Pick<DeliveryRecord, "source_block_id" | "exit_id" | "wait_arrival_id"> = handoff;
    while (author.wait_arrival_id) {
      const [incoming] = yield* sql<
        Pick<DeliveryRecord, "source_block_id" | "exit_id" | "wait_arrival_id">
      >`SELECT i.source_block_id,i.exit_id,i.wait_arrival_id FROM wait_arrivals a JOIN operation_intents i ON i.id=a.incoming_intent_id WHERE a.id=${author.wait_arrival_id}`;
      if (!incoming) break;
      author = incoming;
    }
    return { sourceBlockId: author.source_block_id, exitId: author.exit_id };
  });

/**
 * Continuation arrivals. The first message a Continuation receives in a Run sends its prompt into
 * the worker thread that message belongs to; messages arriving while that prompt is pending wait;
 * afterwards every message is forwarded unchanged with its own worker.
 */
export function openRunContinuations(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** The Continuation's prompt visit in the Run; undefined before any message reached it. */
  const continuationPrompt = (runId: string, blockId: string) =>
    database.transaction((sql) =>
      Effect.map(
        sql<ContinuationPrompt>`SELECT state,incoming_intent_id FROM continuation_visits WHERE run_id=${runId} AND block_id=${blockId} AND kind='prompt'`,
        ([prompt]) => prompt,
      ),
    );

  /** Turns the first released Handoff to a Continuation into its prompt visit: an activation the
   * worker reports against, delivered by a send queued on the Handoff's worker thread. `current`
   * is the snapshot the caller read the release at. Guards: owner, not Archived, live
   * authorization context, open gate and `current`'s generation; the Handoff is still pending and
   * no prompt visit exists. A Handoff without a worker thread is a Block error. Advances the
   * generation and answers the delivery. */
  function sendContinuationPrompt(current: RunRow, handoff: Handoff) {
    return database.mutate(current.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* pendingHandoffHolds(sql, ownerToken, current, handoff.id))) return undefined;
        const prompted =
          yield* sql`SELECT id FROM continuation_visits WHERE run_id=${current.id} AND block_id=${handoff.block_id} AND kind='prompt'`;
        if (prompted.length) return undefined;
        const time = yield* now;
        const [binding] = yield* sql<{
          thread_id: string;
          block_id: string;
        }>`SELECT thread_id,block_id FROM run_thread_bindings WHERE id=${handoff.binding_id}`;
        if (!binding) {
          const problem =
            "No worker thread to continue: the message reached this Continuation without one.";
          yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem=${problem},reconciled_at=${time} WHERE id=${handoff.id}`;
          yield* writeBlockState(sql, { runId: current.id, blockId: handoff.block_id }, "error", {
            problem,
          });
          yield* advanceGeneration(sql, current.id);
          return undefined;
        }
        const target = JSON.parse(handoff.target_json) as StoredTarget;
        const [block] = yield* sql<{
          public_id: string;
        }>`SELECT public_id FROM run_blocks WHERE run_id=${current.id} AND block_id=${handoff.block_id}`;
        const message = continuationPromptMessage(
          current.definitions,
          handoff.block_id,
          yield* messageAuthor(sql, handoff),
          arrivalMessage(handoff),
        );
        const payload = workerRevisitPayload(
          target,
          binding.thread_id,
          handoff.request_key,
          message,
          block!.public_id,
        );
        const activationId = yield* newId;
        // The follow-up runs on the worker's own settings, so it carries that worker's Agent
        // revision; a Continuation has none of its own.
        yield* sql`INSERT INTO run_activations(id,run_id,block_id,cause,created_at,agent_revision_id) VALUES(${activationId},${current.id},${handoff.block_id},${handoff.cause},${time},(SELECT agent_revision_id FROM run_activations WHERE run_id=${current.id} AND block_id=${binding.block_id} ORDER BY rowid DESC LIMIT 1))`;
        yield* sql`INSERT INTO activation_messages(activation_id,request_key,input_fingerprint) VALUES(${activationId},${handoff.request_key},${fingerprint(payload.message)})`;
        yield* sql`INSERT INTO continuation_visits(id,run_id,block_id,incoming_intent_id,kind,source_block_id,binding_id,activation_id,state,arrived_at) VALUES(${yield* newId},${current.id},${handoff.block_id},${handoff.id},'prompt',${handoff.source_block_id},${handoff.binding_id},${activationId},'sent',${time})`;
        const body = JSON.stringify(payload);
        yield* sql`UPDATE operation_intents SET kind='send',target_json=${JSON.stringify({ ...target, threadId: binding.thread_id })},payload_json=${body},fingerprint=${fingerprint(body)} WHERE id=${handoff.id}`;
        yield* writeBlockState(sql, { runId: current.id, blockId: handoff.block_id }, "sent", {
          problem: null,
        });
        yield* advanceGeneration(sql, current.id);
        const [delivery] =
          yield* sql<DeliveryRecord>`SELECT * FROM operation_intents WHERE id=${handoff.id}`;
        return delivery && asDelivery(delivery);
      }),
    );
  }

  /** Records a message that reached a Continuation while its prompt is pending; it waits as a
   * Handoff. Guards: owner, not Archived and live authorization context. Advances the generation
   * when it records the wait. */
  function queueContinuationArrival(current: RunRow, handoff: Handoff) {
    return database.mutate(current.id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, current.id, {
          owner: true,
          notArchived: true,
          liveContext: current.context_id,
        });
        if (!held) return;
        const time = yield* now;
        const queued =
          yield* sql`INSERT INTO continuation_visits(id,run_id,block_id,incoming_intent_id,kind,source_block_id,binding_id,state,arrived_at) VALUES(${yield* newId},${current.id},${handoff.block_id},${handoff.id},'pass-through',${handoff.source_block_id},${handoff.binding_id},'queued',${time}) ON CONFLICT(incoming_intent_id) DO NOTHING RETURNING id`;
        if (!queued.length) return;
        yield* appendTimelineEvent(sql, {
          kind: "continuation-queued",
          runId: current.id,
          blockId: handoff.block_id,
          intentId: handoff.id,
          observedAt: time,
        });
        yield* advanceGeneration(sql, current.id);
      }),
    );
  }

  /** Forwards a message unchanged to the Continuation's recipients, keeping the message's worker
   * thread and activation,
   * once the prompt's response is out. Guards: owner, not Archived, live authorization context,
   * open gate and `current`'s generation; the Handoff is still pending. Acknowledges the arrival,
   * creates released Handoffs, advances the generation and appends "passed through". */
  function passThroughArrival(current: RunRow, handoff: Handoff) {
    return database.mutate(current.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* pendingHandoffHolds(sql, ownerToken, current, handoff.id))) return;
        const message = arrivalMessage(handoff);
        const time = yield* now;
        const [visit] = yield* sql<{
          id: string;
        }>`INSERT INTO continuation_visits(id,run_id,block_id,incoming_intent_id,kind,source_block_id,binding_id,state,arrived_at,forwarded_at) VALUES(${yield* newId},${current.id},${handoff.block_id},${handoff.id},'pass-through',${handoff.source_block_id},${handoff.binding_id},'forwarded',${time},${time}) ON CONFLICT(incoming_intent_id) DO UPDATE SET state='forwarded',forwarded_at=excluded.forwarded_at RETURNING id`;
        yield* sql`UPDATE operation_intents SET state='acknowledged',payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${handoff.id}`;
        const recipients = [
          ...new Set(
            current.definitions.flow.graph.connections
              .filter(
                (edge) =>
                  edge.sourceBlockId === handoff.block_id && edge.exitId === CONTINUATION_EXIT.id,
              )
              .map((edge) => edge.targetBlockId),
          ),
        ];
        const target = JSON.parse(handoff.target_json) as StoredTarget;
        const payload = JSON.stringify({ message });
        for (const blockId of recipients) {
          const id = yield* newId,
            cause = `pass:${visit!.id}/recipient:${blockId}`;
          const inserted =
            yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,source_block_id,exit_id,binding_id,origin_activation_id)
              VALUES(${id},${current.id},${blockId},'handoff',${cause},${JSON.stringify({ ...target, blockId })},${fingerprint(cause)},${payload},${fingerprint(payload)},${current.context_id},${handoff.block_id},${CONTINUATION_EXIT.id},${handoff.binding_id},${handoff.origin_activation_id}) ON CONFLICT(run_id,cause) DO NOTHING RETURNING id`;
          if (inserted.length)
            yield* appendTimelineEvent(sql, {
              kind: "handoff-created",
              runId: current.id,
              blockId,
              cause,
              intentId: id,
              observedAt: time,
            });
        }
        yield* appendTimelineEvent(sql, {
          kind: "continuation-passed",
          runId: current.id,
          blockId: handoff.block_id,
          intentId: handoff.id,
          observedAt: time,
        });
        yield* advanceGeneration(sql, current.id);
      }),
    );
  }

  /** Whether another Block's Factory task on `threadId` was delivered and still owes its Final
   * result: Factory work sharing a thread is serialized, so a send to it waits. */
  const threadOwesOtherTask = (runId: string, threadId: string, blockId: string) =>
    database.transaction((sql) =>
      Effect.map(
        sql`SELECT a.id FROM run_activations a JOIN run_blocks b ON b.run_id=a.run_id AND b.block_id=a.block_id
          LEFT JOIN continuation_visits v ON v.activation_id=a.id LEFT JOIN run_thread_bindings t ON t.id=v.binding_id
          WHERE a.run_id=${runId} AND a.block_id!=${blockId} AND a.phase!='finished' AND COALESCE(t.thread_id,b.thread_id)=${threadId}
          AND (v.id IS NULL OR v.state='sent')
          AND EXISTS(SELECT 1 FROM run_executions e WHERE e.run_id=a.run_id AND e.activation_id=a.id)
          AND NOT EXISTS(SELECT 1 FROM runtime_reports r WHERE r.activation_id=a.id AND r.status='finished')
          AND a.rowid=(SELECT MAX(l.rowid) FROM run_activations l WHERE l.run_id=a.run_id AND l.block_id=a.block_id)`,
        (rows) => rows.length > 0,
      ),
    );

  /** Continuation results not yet released, newest version each: releasing one forwards the
   * response even when the Continuation has no recipients. */
  const heldContinuationResults = (runId: string) =>
    database.transaction((sql) =>
      Effect.map(
        sql<{
          report_id: string;
        }>`SELECT (SELECT r.id FROM runtime_reports r WHERE r.activation_id=v.activation_id AND r.status='finished' ORDER BY r.rowid DESC LIMIT 1) AS report_id FROM continuation_visits v WHERE v.run_id=${runId} AND v.kind='prompt' AND v.state='sent'`,
        (rows) => rows.flatMap((row) => (row.report_id ? [row.report_id] : [])),
      ),
    );

  return {
    continuationPrompt,
    sendContinuationPrompt,
    queueContinuationArrival,
    passThroughArrival,
    threadOwesOtherTask,
    heldContinuationResults,
  };
}

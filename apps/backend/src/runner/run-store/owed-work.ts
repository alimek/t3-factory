import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { cancelTitleGeneration } from "../../run-titles.ts";
import type { HumanRow } from "../runner-types.ts";
import { settleAttention } from "./attention.ts";
import { writeBlockState } from "./blocks.ts";
import type { DeliveryRecord } from "./records.ts";
import type { DeliveryState } from "./states.ts";
import { appendTimelineEvent } from "./steps.ts";
import { clearSpentWaitMessages } from "./waits.ts";

const pending: DeliveryState = "pending";
const cancelled: DeliveryState = "cancelled";

/** The user action that ends a Run's automatic work, with the reasons it records. */
const CUTOFFS = {
  archive: { intentProblem: "cancelled-on-Archive", attentionReason: "archived" },
  settle: { intentProblem: "cancelled-on-Settle", attentionReason: "manual-settlement" },
} as const;

/** Nothing unsent leaves the Run any more: pending launches, sends and handoffs are cancelled,
 * pending Human occurrences and Wait arrivals too without inventing answers, pending attention
 * settles with the cutoff's reason, waiting Continuation arrivals are cancelled, a pending Run
 * title generation is cancelled and activated Blocks that had not finished show stopped.
 * In-flight or uncertain operations keep their recorded state. */
export function cancelOwedWork(
  sql: SqlClient.SqlClient,
  id: string,
  time: string,
  cutoff: keyof typeof CUTOFFS,
) {
  const { intentProblem, attentionReason } = CUTOFFS[cutoff];
  return Effect.gen(function* () {
    const intents =
      yield* sql<DeliveryRecord>`SELECT * FROM operation_intents WHERE run_id=${id} AND state=${pending}`;
    for (const intent of intents) {
      yield* sql`UPDATE operation_intents SET state=${cancelled},payload_json=NULL,problem=${intentProblem},reconciled_at=${time} WHERE id=${intent.id}`;
      yield* appendTimelineEvent(sql, {
        kind: "operation-cancelled",
        runId: id,
        blockId: intent.block_id,
        intentId: intent.id,
        observedAt: time,
      });
    }
    yield* sql`UPDATE runtime_reports SET pending_message=NULL WHERE run_id=${id}`;
    const humans =
      yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE run_id=${id} AND state='pending'`;
    for (const occurrence of humans) {
      yield* sql`UPDATE human_occurrences SET state='cancelled',pending_context=NULL,settled_at=${time} WHERE id=${occurrence.id}`;
      yield* appendTimelineEvent(sql, {
        kind: "human-cancelled",
        runId: id,
        blockId: occurrence.block_id,
        occurrenceId: occurrence.id,
        observedAt: time,
      });
    }
    const waits = yield* sql<{
      id: string;
      block_id: string;
    }>`SELECT id,block_id FROM wait_arrivals WHERE run_id=${id} AND state='pending'`;
    for (const arrival of waits) {
      yield* sql`UPDATE wait_arrivals SET state='cancelled',message=NULL,settled_at=${time} WHERE id=${arrival.id}`;
      yield* appendTimelineEvent(sql, {
        kind: "wait-cancelled",
        runId: id,
        blockId: arrival.block_id,
        arrivalId: arrival.id,
        observedAt: time,
      });
    }
    const attention = yield* sql<{
      id: string;
      block_id: string;
      execution_id: string;
    }>`SELECT id,block_id,execution_id FROM run_attention WHERE run_id=${id} AND settled_at IS NULL`;
    yield* settleAttention(
      sql,
      attention.map((matter) => ({
        id: matter.id,
        runId: id,
        blockId: matter.block_id,
        executionId: matter.execution_id,
      })),
      attentionReason,
      time,
    );
    yield* sql`UPDATE continuation_visits SET state='cancelled' WHERE run_id=${id} AND state IN ('queued','sent')`;
    yield* cancelTitleGeneration(sql, id, time, cutoff);
    yield* writeBlockState(
      sql,
      { runId: id },
      { keep: ["not-started", "finished", "pass-through"], otherwise: "stopped" },
      { problem: null },
    );
    // Archive clears every Wait message, including those forwarded arrivals kept for their
    // recipients; manual settlement keeps the ones a recipient's visit still reads. Outcomes,
    // deadlines and identities stay.
    if (cutoff === "archive") yield* sql`UPDATE wait_arrivals SET message=NULL WHERE run_id=${id}`;
    else yield* clearSpentWaitMessages(sql, id);
  });
}

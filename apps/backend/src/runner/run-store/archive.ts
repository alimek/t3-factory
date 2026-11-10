import type { Result } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "../../result.ts";
import type { HumanRow } from "../runner-types.ts";
import { now } from "../../time.ts";
import { settleAttention } from "./attention.ts";
import { guardsHold } from "./guards.ts";
import { withLifecycle } from "./lifecycle.ts";
import { clearSnooze } from "./presentation.ts";
import type { DeliveryRecord } from "./records.ts";
import type { RunnerDatabase } from "./database.ts";
import { writeBlockState } from "./blocks.ts";
import type { DeliveryState } from "./states.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

const pending: DeliveryState = "pending";
const cancelled: DeliveryState = "cancelled";

/** Nothing unsent leaves an archived Run: pending launches, handoffs, Human occurrences and Wait
 * arrivals are cancelled without inventing answers, pending attention settles and unfinished
 * activated Blocks show stopped. In-flight or uncertain operations keep their recorded state. */
function cancelUnsentWork(sql: SqlClient.SqlClient, id: string, time: string) {
  return Effect.gen(function* () {
    const intents =
      yield* sql<DeliveryRecord>`SELECT * FROM operation_intents WHERE run_id=${id} AND state=${pending}`;
    for (const intent of intents) {
      yield* sql`UPDATE operation_intents SET state=${cancelled},payload_json=NULL,problem='cancelled-on-Archive',reconciled_at=${time} WHERE id=${intent.id}`;
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
      yield* sql`UPDATE wait_arrivals SET state='cancelled',settled_at=${time} WHERE id=${arrival.id}`;
      yield* appendTimelineEvent(sql, {
        kind: "wait-cancelled",
        runId: id,
        blockId: arrival.block_id,
        arrivalId: arrival.id,
        observedAt: time,
      });
    }
    // Archive clears every Wait message, including those forwarded arrivals kept for their
    // recipients; outcomes, deadlines and identities stay.
    yield* sql`UPDATE wait_arrivals SET message=NULL WHERE run_id=${id}`;
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
      "archived",
      time,
    );
    yield* sql`UPDATE continuation_visits SET state='cancelled' WHERE run_id=${id} AND state IN ('queued','sent')`;
    yield* writeBlockState(
      sql,
      { runId: id },
      { keep: ["not-started", "finished", "pass-through"], otherwise: "stopped" },
      { problem: null },
    );
  });
}

export function openRunArchive(database: RunnerDatabase) {
  /** Archive is final. Guards: the Run exists; an Archived Run is left unchanged; this backend
   * owns the database. It closes the gate and advances the generation once. Answers whether the
   * Run changed. */
  function archive(id: string): Effect.Effect<Result<boolean>, unknown> {
    return withLifecycle<boolean>(database, id, (sql, run) =>
      Effect.gen(function* () {
        if (run.archived_at) return { ok: true as const, value: false };
        if (!(yield* guardsHold(sql, database.owner.token, id, { owner: true })))
          return failure("conflict", "Runner ownership changed.");
        const time = yield* now;
        yield* sql`UPDATE runs SET gate_open=0,archived_at=${time} WHERE id=${id}`;
        yield* advanceGeneration(sql, id);
        yield* cancelUnsentWork(sql, id, time);
        yield* clearSnooze(sql, id);
        yield* appendTimelineEvent(sql, { kind: "run-archived", runId: id, observedAt: time });
        return { ok: true as const, value: true };
      }),
    );
  }

  /** The worker threads Archive interrupts in T3. */
  const boundWorkerThreads = (id: string) =>
    database.transaction(
      (sql) =>
        sql<{
          thread_id: string;
        }>`SELECT thread_id FROM run_blocks WHERE run_id=${id} AND thread_id IS NOT NULL ORDER BY rowid`,
    );

  return { archive, boundWorkerThreads };
}

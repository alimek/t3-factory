import { releaseResult } from "./result-release.ts";
import { readWorkerThread } from "./worker-thread.ts";
import * as Effect from "effect/Effect";
import type { ExecutionObservation, T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner/run-store/run-store.ts";
import { newId } from "./ids.ts";
import type { IntentRow, RunRow } from "./runner-types.ts";
import { fingerprint } from "./runner-utils.ts";
import { now } from "./time.ts";

/** A thread T3 shows with no run and no native request has no earlier turn to wait for, as an idle
 * worker prepared before Factory stopped preparing them, whose first visit is a queued send. */
const neverRan = (thread: ExecutionObservation) =>
  !thread.activeRunId &&
  !thread.latestRunId &&
  thread.recentRuns.length === 0 &&
  thread.pendingRequestCount === 0;

/** A released worker result (or a durable Human answer) and, for a revisit, a finished target thread. */
function explicitSourceReleaseGeneration(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  intent: IntentRow,
) {
  return Effect.gen(function* () {
    const current = yield* database.row(run.id);
    if (!current) return null;
    if (intent.report_id) {
      if (!(yield* releaseResult(database, t3, current, intent.report_id))) return null;
    } else {
      const answered = yield* database.transaction(
        (sql) =>
          sql`SELECT id FROM human_occurrences WHERE id=${intent.occurrence_id} AND run_id=${run.id} AND block_id=${intent.source_block_id} AND state='answered'`,
      );
      if (!answered.length) return null;
    }
    if (intent.kind === "send") {
      const { threadId } = JSON.parse(intent.target_json) as { threadId: string };
      const target = yield* Effect.tryPromise(() => readWorkerThread(t3, current, threadId));
      if (!target.finished && !neverRan(target.thread)) return null;
    }
    return current.generation;
  });
}

/** Converts a pending Human handoff after optional explicit source release; no-op when held. */
export function activatePendingHumanHandoff(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: IntentRow,
) {
  return Effect.gen(function* () {
    const generation = intent.report_id
      ? yield* explicitSourceReleaseGeneration(database, t3, runRow, intent)
      : undefined;
    if (generation === null) return;
    yield* database.mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        const [current] =
          yield* sql`SELECT id FROM runs WHERE id=${runRow.id} AND gate_open=1 AND (${generation ?? null} IS NULL OR generation=${generation ?? null}) AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${intent.context_id}) AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${database.owner.token})`;
        const [pendingIntent] =
          yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE id=${intent.id} AND state='pending'`;
        if (!current || !pendingIntent) return;
        if (
          !pendingIntent.payload_json ||
          fingerprint(pendingIntent.payload_json) !== pendingIntent.fingerprint
        )
          return yield* Effect.fail(Error("Invalid Human context"));
        const id = yield* newId,
          time = yield* now;
        const context = (
          JSON.parse(pendingIntent.payload_json) as {
            message: string;
          }
        ).message;
        if (generation !== undefined)
          yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${intent.block_id},'handoff-released',${"release:" + intent.id},${intent.id},${time}) ON CONFLICT DO NOTHING`;
        yield* sql`INSERT INTO human_occurrences(id,run_id,block_id,incoming_intent_id,pending_context,appeared_at) VALUES(${id},${runRow.id},${intent.block_id},${intent.id},${context},${time})`;
        yield* sql`UPDATE operation_intents SET state='acknowledged',payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${intent.id}`;
        yield* sql`UPDATE run_blocks SET state='waiting',freshness='fresh',observed_at=${time} WHERE run_id=${runRow.id} AND block_id=${intent.block_id}`;
        yield* sql`INSERT INTO run_attention(id,run_id,block_id,execution_id,kind,source_key,occurrence_id,appeared_at) VALUES(${id},${runRow.id},${intent.block_id},'', 'human',${"human:" + id},${id},${time})`;
        yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${intent.block_id},'human-waiting',${"human:" + id},${id},${time})`;
        yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${intent.block_id},'attention-appeared',${"human-attention:" + id},${id},${time})`;
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
      }),
    );
  });
}

/** Reserves a pending Agent handoff after explicit source release; false when held or guards fail. */
export function reservePendingExplicitHandoff(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: IntentRow,
  retryScope: string | null,
) {
  return Effect.gen(function* () {
    const generation = yield* explicitSourceReleaseGeneration(database, t3, runRow, intent);
    if (generation === null) return false;
    return yield* database.reserveIntent(runRow, intent, retryScope, generation);
  });
}

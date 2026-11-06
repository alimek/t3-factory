import { rootInvocation } from "./run-coordinator-commands.ts";
import { delegationFingerprint } from "./adapters/delegation-activity.ts";
import { releaseCoordinatorSource } from "./coordinator-release.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import { coordinatorGate } from "./runner-coordinator-gate.ts";
import * as Effect from "effect/Effect";
import type { RunSnapshot } from "@t3-factory/contracts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { IntentRow, RunRow, StoredTarget } from "./runner-types.ts";
import { coordinatorLaunch, persistActivation } from "./runner-coordination.ts";
import { launchPayload } from "./runner-handoffs.ts";
import { fingerprint } from "./runner-utils.ts";
import { newId } from "./ids.ts";
import { now } from "./time.ts";

/** Independent arrivals reserve a new activation only after the target conversation settles. */
export function prepareCoordinatorHandoff(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  intent: IntentRow,
) {
  return Effect.gen(function* () {
    const current = yield* database.row(run.id);
    if (!current || !current.gate_open || !intent.source_block_id) return undefined;
    // Keep held arrivals as handoffs, not phantom delegating activations. Reservation
    // independently repeats this gate before any external effect.
    if (!(yield* sourceReleased(database, t3, current, intent))) return undefined;
    const [prior] = yield* database.transaction(
      (sql) =>
        sql<{
          id: string;
          original_id: string;
          accepted_json: string;
          thread_id: string;
        }>`SELECT a.id,COALESCE(v.original_activation_id,a.id) AS original_id,d.accepted_json,b.thread_id FROM run_activations a JOIN run_delegations d ON d.activation_id=COALESCE((SELECT original_activation_id FROM coordinator_revisits WHERE activation_id=a.id),a.id) JOIN run_blocks b ON b.run_id=a.run_id AND b.block_id=a.block_id LEFT JOIN coordinator_revisits v ON v.activation_id=a.id WHERE a.run_id=${run.id} AND a.block_id=${intent.block_id} ORDER BY a.rowid DESC LIMIT 1`,
    );
    const pending = yield* database.transaction(
      (sql) =>
        sql`SELECT c.activation_id FROM run_coordinator_commands c JOIN run_activations a ON a.id=c.activation_id WHERE c.run_id=${run.id} AND a.block_id=${intent.block_id} AND (c.state!='accepted' OR ${prior ? 0 : 1}=1)`,
    );
    if (pending.length) return undefined;
    if (prior && !(yield* coordinatorGate(database, t3, current, intent.block_id)))
      return undefined;
    if (
      prior &&
      !(yield* releaseCoordinatorSource(database, t3, current, intent.block_id, prior.id))
    )
      return undefined;
    return yield* database.mutate(run.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, current, true))) return undefined;
        const valid =
          yield* sql`SELECT i.id FROM operation_intents i JOIN runs r ON r.id=i.run_id WHERE i.id=${intent.id} AND i.kind='handoff' AND i.state='pending' AND r.generation=${current.generation}`;
        if (!valid.length) return undefined;
        if (!intent.payload_json || fingerprint(intent.payload_json) !== intent.fingerprint)
          throw Error("Invalid handoff payload");
        const snapshot = JSON.parse(run.snapshot_json) as RunSnapshot;
        const target = JSON.parse(intent.target_json) as StoredTarget;
        const message = (JSON.parse(intent.payload_json) as { message: string }).message;
        const plan = coordinatorLaunch(
          snapshot,
          intent.block_id,
          message,
          yield* newId,
          yield* newId,
          launchPayload(snapshot, intent.block_id, target, intent.request_key, message),
        );
        yield* persistActivation(sql, run.id, intent.block_id, yield* now, plan, intent.cause);
        let payload:
          | import("./adapters/t3.ts").LaunchPayload
          | import("./adapters/t3.ts").SendPayload = plan.payload;
        if (prior) {
          payload = {
            environmentId: target.environmentId,
            threadId: prior.thread_id,
            mode: "queue",
            clientRequestId: intent.request_key,
            message: plan.payload.message,
          };
          yield* sql`UPDATE run_delegations SET accepted_json=${prior.accepted_json} WHERE activation_id=${plan.activationId}`;
          yield* sql`INSERT INTO coordinator_revisits(activation_id,original_activation_id) VALUES(${plan.activationId},${prior.original_id})`;
          yield* sql`UPDATE run_activations SET phase='finished' WHERE id=${prior.id}`;
          yield* sql`UPDATE operation_intents SET target_json=${JSON.stringify({ ...target, threadId: prior.thread_id })} WHERE id=${intent.id}`;
        }
        if (!prior) {
          const invocation = rootInvocation(
            snapshot,
            intent.block_id,
            plan.payload.message,
            plan.requestKey,
          );
          yield* sql`INSERT INTO run_coordinator_commands(activation_id,run_id,request_key,invocation_json,invocation_fingerprint,plan_json,send_key,intent_id) VALUES(${plan.activationId},${run.id},${invocation.clientRequestId},${JSON.stringify(invocation)},${delegationFingerprint(invocation)},${JSON.stringify(plan.payload.message)},${yield* newId},${intent.id})`;
        }
        const body = JSON.stringify(payload);
        yield* sql`UPDATE operation_intents SET kind=${prior ? "send" : "launch"},payload_json=${body},fingerprint=${fingerprint(body)} WHERE id=${intent.id} AND kind='handoff' AND state='pending'`;
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        return (yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE id=${intent.id}`)[0];
      }),
    );
  });
}

/** Human answers are durable authority; Agent reports still require source release 033. */
function sourceReleased(
  database: RunnerDatabase,
  t3: T3Adapter,
  current: RunRow,
  intent: IntentRow,
) {
  return Effect.gen(function* () {
    if (intent.occurrence_id && !intent.report_id) {
      const rows = yield* database.transaction(
        (sql) =>
          sql`SELECT id FROM human_occurrences WHERE id=${intent.occurrence_id} AND run_id=${current.id} AND block_id=${intent.source_block_id} AND state='answered'`,
      );
      return rows.length === 1;
    }
    const [source] = yield* database.transaction(
      (sql) =>
        sql<{
          activation_id: string;
        }>`SELECT activation_id FROM runtime_reports WHERE id=${intent.report_id}`,
    );
    return (
      !!source &&
      (yield* releaseCoordinatorSource(
        database,
        t3,
        current,
        intent.source_block_id!,
        source.activation_id,
      ))
    );
  });
}

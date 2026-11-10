import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunRow } from "../runner-types.ts";
import { fingerprint } from "../runner-utils.ts";
import { scopedThreadHref } from "../../thread-link.ts";
import { now } from "../../time.ts";
import { guardsHold } from "./guards.ts";
import type { Delivery, DeliveryRecord, Handoff } from "./records.ts";
import { handoffReleased } from "./release.ts";
import type { RunnerDatabase } from "./database.ts";
import type { BlockState, DeliveryKind } from "./states.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

const working: BlockState = "working";
const error: BlockState = "error";

/** A send's worker turn holds its Block until an observation sees the turn's run. */
const UNOBSERVED_WORKER_HOLD = "Worker thread not observed yet.";

/** What T3 answered for an acknowledged send; stored as given. */
type SendAcknowledgement = {
  readonly threadId: string;
  readonly runId: string;
  readonly status: string;
};

/** The worker thread T3 launched, or the one launch search matched; stored as given. */
type LaunchedWorker = SendAcknowledgement & {
  readonly projectId: string;
  readonly link: string | null;
};

/** A new pending delivery, recorded before any T3 call. */
export function createDelivery(
  sql: SqlClient.SqlClient,
  delivery: {
    readonly id: string;
    readonly runId: string;
    readonly blockId: string;
    readonly kind: DeliveryKind;
    readonly cause: string;
    readonly target: object;
    readonly requestKey: string;
    readonly payload: object;
    readonly contextId: string;
    readonly retryScope: string | null;
  },
) {
  const body = JSON.stringify(delivery.payload);
  return sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,retry_scope)
    VALUES(${delivery.id},${delivery.runId},${delivery.blockId},${delivery.kind},${delivery.cause},${JSON.stringify(delivery.target)},${delivery.requestKey},${body},${fingerprint(body)},${delivery.contextId},${delivery.retryScope})`;
}

/** Whether a Block still has a Handoff or delivery that is neither acknowledged nor cancelled. */
export function blockHasUnresolvedWork(sql: SqlClient.SqlClient, runId: string, blockId: string) {
  return Effect.map(
    sql`SELECT id FROM operation_intents WHERE run_id=${runId} AND block_id=${blockId} AND state NOT IN ('acknowledged','cancelled')`,
    (rows) => rows.length > 0,
  );
}

/** A worker binding keeps the newest thread link T3 shows. */
export function refreshWorkerLink(
  sql: SqlClient.SqlClient,
  bindingId: string,
  link: string | null,
) {
  return sql`UPDATE run_thread_bindings SET link=COALESCE(${link},link) WHERE id=${bindingId}`;
}

/** The stored record as a delivery, once its kind is a launch or a send. */
export function asDelivery(record: DeliveryRecord): Delivery | undefined {
  return record.kind === "launch" || record.kind === "send"
    ? { ...record, kind: record.kind }
    : undefined;
}

type UnresolvedRecord = Omit<DeliveryRecord, "kind"> & { kind: "handoff" | DeliveryKind };

export function openRunDeliveries(database: RunnerDatabase) {
  const { owner, mutate } = database;

  /** The Runs a reconcile sweep drives: open ones, and Settled ones still owing a delivery. */
  const runsToReconcile = () =>
    database.transaction(
      (sql) =>
        sql<{
          id: string;
        }>`SELECT id FROM runs WHERE archived_at IS NULL AND (settled_at IS NULL OR EXISTS(SELECT 1 FROM operation_intents i WHERE i.run_id=runs.id AND i.state IN ('pending','reserved','uncertain'))) ORDER BY started_at,id`,
    );

  /** The Run's Handoffs not yet turned into deliveries and its deliveries not yet acknowledged or
   * cancelled, in the order they were recorded. */
  const dispatchable = (run: Pick<RunRow, "id" | "context_id">) =>
    database.transaction((sql) =>
      Effect.gen(function* () {
        const records =
          yield* sql<UnresolvedRecord>`SELECT * FROM operation_intents WHERE run_id=${run.id} AND state IN ('pending','reserved','uncertain') AND kind IN ('handoff','launch','send') ORDER BY rowid`;
        const work: (Handoff | Delivery)[] = [];
        for (const record of records)
          work.push(
            record.kind === "handoff"
              ? {
                  ...record,
                  kind: record.kind,
                  state: (yield* handoffReleased(sql, run, record)) ? "released" : "held",
                }
              : { ...record, kind: record.kind },
          );
        return work;
      }),
    );

  /** Notes a Handoff or delivery unresolved with `message`; a reserved delivery becomes
   * uncertain. No guard. Advances the generation and appends "operation unresolved" only when the
   * record changed. */
  function noteUnresolved(record: Handoff | Delivery, message: string) {
    return mutate(record.run_id, (sql) =>
      Effect.gen(function* () {
        const time = yield* now;
        const changed =
          yield* sql`UPDATE operation_intents SET state=CASE WHEN state='reserved' THEN 'uncertain' ELSE state END,problem=${message},reconciled_at=${time} WHERE id=${record.id} AND state NOT IN ('acknowledged','cancelled') AND (problem IS NOT ${message} OR state='reserved') RETURNING id`;
        if (!changed.length) return;
        yield* advanceGeneration(sql, record.run_id);
        yield* appendTimelineEvent(sql, {
          kind: "operation-unresolved",
          runId: record.run_id,
          blockId: record.block_id,
          intentId: record.id,
          observedAt: time,
        });
      }),
    );
  }

  /** Reserves `delivery` before its one T3 request. Guards: its state is unchanged since the
   * caller's read, the generation (when given, a source release the caller read) holds, the gate
   * is open, the project is available at the Run's checkout, the delivery's authorization context
   * is live, this backend owns the database, a pending Request report send is still eligible, and
   * no other delivery of the Run is reserved. Advances the generation when it reserves. */
  function reserveDelivery(
    runRow: RunRow,
    delivery: Delivery,
    retryScope: string | null,
    releaseGeneration?: number,
  ) {
    return mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE operation_intents SET state='reserved',reserved_by=${owner.token},reserved_at=${yield* now},retry_scope=${delivery.state === "pending" ? retryScope : delivery.retry_scope},problem=NULL,recovery_attempt=${delivery.state === "pending" ? 0 : delivery.recovery_attempt},recovery_not_before=${delivery.state === "pending" ? null : delivery.recovery_not_before}
        WHERE id=${delivery.id} AND state=${delivery.state}
        AND (${releaseGeneration ?? null} IS NULL OR EXISTS(SELECT 1 FROM runs WHERE id=${runRow.id} AND generation=${releaseGeneration ?? null}))
        AND EXISTS(SELECT 1 FROM runs WHERE id=${runRow.id} AND gate_open=1)
        AND EXISTS(SELECT 1 FROM projects WHERE id=${runRow.project_id} AND workspace_root=${runRow.workspace_root} AND availability='available')
        AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${delivery.context_id})
        AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${owner.token})
        AND (${delivery.cause.startsWith("recovery:") && delivery.state === "pending" ? 1 : 0}=0 OR EXISTS(
          SELECT 1 FROM report_recoveries rr JOIN run_executions e ON e.run_id=rr.run_id AND e.block_id=rr.block_id AND e.execution_id=rr.source_execution_id
          JOIN run_blocks b ON b.run_id=rr.run_id AND b.block_id=rr.block_id
          WHERE rr.intent_id=${delivery.id} AND e.engine_status='completed' AND e.report_status IS NOT 'finished' AND b.execution_id=e.execution_id AND b.pending_request_count=0))
        AND NOT EXISTS(SELECT 1 FROM operation_intents WHERE run_id=${runRow.id} AND state='reserved' AND id!=${delivery.id}) RETURNING id`;
        if (changed.length) yield* advanceGeneration(sql, runRow.id);
        return changed.length > 0;
      }),
    );
  }

  /** Acknowledges a reserved send with T3's reference. Guard: this backend reserved it. Records
   * the turn's work period, holds the Block working until the turn is observed, advances the
   * generation and appends "send acknowledged". */
  function acknowledgeSend(runRow: RunRow, delivery: Delivery, reference: SendAcknowledgement) {
    return mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        const [reserved] = yield* sql<{
          id: string;
        }>`SELECT id FROM operation_intents WHERE id=${delivery.id} AND state='reserved' AND reserved_by=${owner.token}`;
        if (!reserved) return;
        const time = yield* now;
        yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify(reference)},payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${delivery.id}`;
        yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,engine_status,binding_id,activation_id) VALUES(${runRow.id},${delivery.block_id},${reference.threadId},${reference.runId},${reference.status},COALESCE((SELECT binding_id FROM coordinator_question_replies WHERE intent_id=${delivery.id}),(SELECT id FROM run_thread_bindings WHERE run_id=${runRow.id} AND thread_id=${reference.threadId})),COALESCE((SELECT activation_id FROM coordinator_question_replies WHERE intent_id=${delivery.id}),(SELECT id FROM run_activations WHERE run_id=${runRow.id} AND block_id=${delivery.block_id} ORDER BY rowid DESC LIMIT 1))) ON CONFLICT DO NOTHING`;
        yield* sql`UPDATE run_blocks SET state=${working},execution_id=${reference.runId},engine_status=${reference.status},report_status=NULL,problem=${UNOBSERVED_WORKER_HOLD},freshness='unknown' WHERE run_id=${runRow.id} AND block_id=${delivery.block_id}`;
        yield* advanceGeneration(sql, runRow.id);
        yield* appendTimelineEvent(sql, {
          kind: "send-acknowledged",
          runId: runRow.id,
          blockId: delivery.block_id,
          executionId: reference.runId,
          intentId: delivery.id,
          engineStatus: reference.status,
          observedAt: time,
        });
      }),
    );
  }

  /** Binds the worker a reserved or uncertain launch started, from T3's reply or a matching
   * launch search. An incomplete reference fails the transition. Guards: owner, not Archived and
   * live authorization context; the launch still holds its payload. Records the worker binding and
   * its work period, sets the Block working, acknowledges the launch, advances the generation and
   * appends "launch acknowledged". */
  function bindLaunchedWorker(runRow: RunRow, delivery: Delivery, reference: LaunchedWorker) {
    return mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        if (!reference.threadId || !reference.runId || reference.projectId !== runRow.t3_project_id)
          return yield* Effect.fail(Error("Invalid launch reference; outcome is uncertain"));
        const held = yield* guardsHold(sql, owner.token, runRow.id, {
          owner: true,
          notArchived: true,
          liveContext: runRow.context_id,
        });
        if (!held) return;
        const [reserved] = yield* sql<{
          id: string;
        }>`SELECT id FROM operation_intents WHERE id=${delivery.id} AND state IN ('reserved','uncertain') AND payload_json IS NOT NULL`;
        if (!reserved) return;
        const time = yield* now;
        const bindingId = randomUUID();
        const link = scopedThreadHref(runRow.environment_id, reference.threadId);
        yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,link) VALUES(${bindingId},${runRow.id},${delivery.block_id},${runRow.environment_id},${reference.threadId},'worker',${link}) ON CONFLICT DO NOTHING`;
        const [binding] = yield* sql<{
          id: string;
        }>`SELECT id FROM run_thread_bindings WHERE run_id=${runRow.id} AND thread_id=${reference.threadId}`;
        const [activation] = yield* sql<{
          id: string;
        }>`SELECT id FROM run_activations WHERE run_id=${runRow.id} AND block_id=${delivery.block_id} ORDER BY rowid DESC LIMIT 1`;
        if (!binding || !activation)
          return yield* Effect.fail(Error("Worker binding is incomplete"));
        yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,binding_id,activation_id,engine_status) VALUES(${runRow.id},${delivery.block_id},${reference.threadId},${reference.runId},${binding.id},${activation.id},${reference.status}) ON CONFLICT DO NOTHING`;
        yield* sql`UPDATE run_blocks SET thread_id=${reference.threadId},execution_id=COALESCE(execution_id,${reference.runId}),state=${working},link=${link},engine_status=${reference.status},problem=NULL WHERE run_id=${runRow.id} AND block_id=${delivery.block_id} AND thread_id IS NULL`;
        yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify(reference)},payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${delivery.id} AND state IN ('reserved','uncertain')`;
        yield* advanceGeneration(sql, runRow.id);
        yield* appendTimelineEvent(sql, {
          kind: "launch-acknowledged",
          runId: runRow.id,
          blockId: delivery.block_id,
          executionId: reference.runId,
          intentId: delivery.id,
          engineStatus: reference.status,
          observedAt: time,
        });
      }),
    );
  }

  /** A launch that cannot happen cancels it and is a Block error. Without the Run worktree, no
   * other Flow-input worker launches. Guards: owner, not Archived and live authorization context;
   * the launch is not yet acknowledged or cancelled. Advances the generation when it cancels. */
  function failLaunch(
    runRow: RunRow,
    delivery: Delivery,
    problem: { readonly block: string; readonly worktree: string },
  ) {
    return mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, owner.token, runRow.id, {
          owner: true,
          notArchived: true,
          liveContext: runRow.context_id,
        });
        if (!held) return;
        const time = yield* now;
        const cancelled =
          yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem=${problem.block},reconciled_at=${time} WHERE id=${delivery.id} AND state IN ('pending','reserved','uncertain') RETURNING id`;
        if (!cancelled.length) return;
        yield* sql`UPDATE run_blocks SET state=${error},problem=${problem.block} WHERE run_id=${runRow.id} AND block_id=${delivery.block_id} AND thread_id IS NULL`;
        const failed =
          yield* sql`UPDATE run_workspaces SET state='failed' WHERE run_id=${runRow.id} AND creator_block_id=${delivery.block_id} AND state='preparing' RETURNING run_id`;
        if (failed.length)
          for (const blockId of runRow.definitions.flow.graph.flowInput.targetBlockIds)
            yield* sql`UPDATE run_blocks SET state=${error},problem=${`${problem.worktree} This worker was not launched.`} WHERE run_id=${runRow.id} AND block_id=${blockId} AND block_id!=${delivery.block_id} AND thread_id IS NULL`;
        yield* advanceGeneration(sql, runRow.id);
      }),
    );
  }

  /** A launch note: one statement on the launch, then the generation advances whether or not the
   * statement changed it. No guard. */
  function noteLaunch(
    launch: Delivery,
    statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>,
  ) {
    return mutate(launch.run_id, (sql) =>
      Effect.gen(function* () {
        yield* statement(sql);
        yield* advanceGeneration(sql, launch.run_id);
      }),
    );
  }

  /** A launch whose reply was lost becomes uncertain: it is only searched for from now on. */
  const noteLaunchUncertain = (launch: Delivery, problem: string) =>
    noteLaunch(launch, (sql) =>
      Effect.flatMap(
        now,
        (time) =>
          sql`UPDATE operation_intents SET state='uncertain',problem=${problem},reconciled_at=${time} WHERE id=${launch.id} AND state IN ('reserved','uncertain')`,
      ),
    );

  /** A launch search that found no single match is searched again from `notBefore`; a reserved
   * launch becomes uncertain. */
  const retryLaunchSearchLater = (
    launch: Delivery,
    problem: string,
    time: string,
    notBefore: string,
  ) =>
    noteLaunch(
      launch,
      (sql) =>
        sql`UPDATE operation_intents SET recovery_attempt=recovery_attempt+1,recovery_not_before=${notBefore},state=CASE WHEN state='reserved' THEN 'uncertain' ELSE state END,problem=${problem},reconciled_at=${time} WHERE id=${launch.id} AND state IN ('reserved','uncertain')`,
    );

  /** A pending launch whose images could not be uploaded stays pending until `notBefore`. */
  const retryImageUploadLater = (
    launch: Delivery,
    problem: string,
    time: string,
    notBefore: string,
  ) =>
    noteLaunch(
      launch,
      (sql) =>
        sql`UPDATE operation_intents SET recovery_attempt=recovery_attempt+1,recovery_not_before=${notBefore},problem=${problem},reconciled_at=${time} WHERE id=${launch.id} AND state='pending'`,
    );

  return {
    runsToReconcile,
    dispatchable,
    noteUnresolved,
    reserveDelivery,
    acknowledgeSend,
    bindLaunchedWorker,
    failLaunch,
    noteLaunchUncertain,
    retryLaunchSearchLater,
    retryImageUploadLater,
  };
}

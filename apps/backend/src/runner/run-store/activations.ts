import type { RunDefinitions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";
import type { RunRow, StoredTarget } from "../runner-types.ts";
import { fingerprint, intactPayload } from "../runner-utils.ts";
import { launchStrategy, type RunWorkspace } from "../run-workspace.ts";
import { now } from "../../time.ts";
import {
  workerLaunchPayload,
  workerRevisitPayload,
  type LaunchImage,
  type StoredLaunchPayload,
} from "../worker-payloads.ts";
import { raiseHumanAttention } from "./attention.ts";
import { asDelivery, createDelivery } from "./deliveries.ts";
import { arrivingHandoff } from "./handoffs.ts";
import { pendingHandoffHolds } from "./guards.ts";
import type { DeliveryRecord, Handoff } from "./records.ts";
import type { RunnerDatabase } from "./database.ts";
import { writeBlockState } from "./blocks.ts";
import type { DeliveryKind } from "./states.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";
import { clearSpentWaitMessages } from "./waits.ts";

/** A Block activation and its first message's identity; it is delivered by a launch or a send. */
function createActivation(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
  plan: { activationId: string; requestKey: string; inputFingerprint: string },
  cause: string,
) {
  return Effect.gen(function* () {
    // An Agent block runs with the revision its Run froze at Start, never the current one.
    yield* sql`INSERT INTO run_activations(id,run_id,block_id,cause,created_at,agent_revision_id) VALUES(${plan.activationId},${runId},${blockId},${cause},${time},(SELECT f.agent_revision_id FROM runs r JOIN flow_revision_blocks b ON b.flow_revision_id=r.flow_revision_id AND b.block_id=${blockId} JOIN run_agent_revisions f ON f.run_id=r.id AND f.agent_id=b.agent_id WHERE r.id=${runId}))`;
    yield* sql`INSERT INTO activation_messages(activation_id,request_key,input_fingerprint) VALUES(${plan.activationId},${plan.requestKey},${plan.inputFingerprint})`;
  });
}

/** An observed activation is assessing until its Final result is reported; a finished
 * activation keeps its phase. */
export function recordActivationPhase(
  sql: SqlClient.SqlClient,
  activationId: string,
  phase: "assessing" | "reported",
  problem: string | null,
) {
  return sql`UPDATE run_activations SET phase=CASE WHEN phase='finished' THEN phase ELSE ${phase} END,problem=${problem} WHERE id=${activationId}`;
}

/** Entry launches are durable before any T3 call: one activation, delivered by a launch, per given
 * Flow-input target. */
export function createEntryLaunches(
  sql: SqlClient.SqlClient,
  plan: {
    runId: string;
    number: number;
    definitions: RunDefinitions;
    workspace: RunWorkspace;
    project: Pick<StoredTarget, "endpoint" | "environmentId" | "projectId" | "workspaceRoot">;
    contextId: string;
    retryScope: string | null;
    time: string;
  },
  blockIds: readonly string[],
) {
  return Effect.gen(function* () {
    const images =
      yield* sql<LaunchImage>`SELECT ordinal,sha256,name,mime_type AS "mimeType",size_bytes AS "sizeBytes" FROM run_images WHERE run_id=${plan.runId} ORDER BY ordinal`;
    for (const blockId of blockIds) {
      const block = plan.definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
      const strategy = launchStrategy(plan.workspace, blockId);
      if (!block || block.kind !== "agent" || !strategy) continue;
      const activationId = yield* newId;
      const requestKey = yield* newId;
      const [saved] = yield* sql<{
        public_id: string;
      }>`SELECT public_id FROM run_blocks WHERE run_id=${plan.runId} AND block_id=${blockId}`;
      const payload = workerLaunchPayload(
        plan.definitions,
        blockId,
        plan.project,
        requestKey,
        plan.number,
        saved!.public_id,
        strategy,
        images,
      );
      const cause = `start:${blockId}`;
      yield* createActivation(
        sql,
        plan.runId,
        blockId,
        plan.time,
        { activationId, requestKey, inputFingerprint: fingerprint(payload.message) },
        cause,
      );
      yield* createDelivery(sql, {
        id: yield* newId,
        runId: plan.runId,
        blockId,
        kind: "launch",
        cause,
        target: { ...plan.project, blockId },
        requestKey,
        payload,
        contextId: plan.contextId,
        retryScope: plan.retryScope,
      });
    }
  });
}

/** The recipient's previous visit: a revisit is sent to its worker thread. */
type PreviousVisit = {
  readonly id: string;
  readonly original_id: string;
  readonly accepted_json: string;
  readonly thread_id: string;
  /** Its current Final result version, which must be released before the revisit. */
  readonly result_id: string | null;
};

export function openRunActivations(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** What a Handoff's arrival at `blockId` waits on: the recipient's previous visit, and whether an
   * unresolved launch for the recipient holds the arrival. */
  const arrivalAt = (runId: string, blockId: string) =>
    database.transaction((sql) =>
      Effect.gen(function* () {
        const [previousVisit] =
          yield* sql<PreviousVisit>`SELECT a.id,COALESCE(v.original_activation_id,a.id) AS original_id,d.accepted_json,b.thread_id,(SELECT r.id FROM runtime_reports r WHERE r.activation_id=a.id AND r.status='finished' ORDER BY r.rowid DESC LIMIT 1) AS result_id FROM run_activations a JOIN activation_messages d ON d.activation_id=COALESCE((SELECT original_activation_id FROM repeated_visits WHERE activation_id=a.id),a.id) JOIN run_blocks b ON b.run_id=a.run_id AND b.block_id=a.block_id LEFT JOIN repeated_visits v ON v.activation_id=a.id WHERE a.run_id=${runId} AND a.block_id=${blockId} ORDER BY a.rowid DESC LIMIT 1`;
        const launches =
          yield* sql`SELECT id FROM operation_intents WHERE run_id=${runId} AND block_id=${blockId} AND kind='launch' AND state NOT IN ('acknowledged','cancelled')`;
        return { previousVisit, launchUnresolved: launches.length > 0 };
      }),
    );

  /** Turns a released Handoff to an Agent Block into a new Block activation, delivered by a launch
   * on a first visit or by a send to the worker thread of `previousVisit` on a revisit. `current`
   * is the snapshot the caller read the release and the recipient at. Guards: owner, not Archived,
   * live authorization context, open gate and `current`'s generation; the Handoff is still
   * pending. A Handoff whose stored message cannot be verified fails the transition. Advances the
   * generation and answers the delivery. */
  function handoffToActivation(
    current: RunRow,
    handoff: Handoff,
    previousVisit: PreviousVisit | undefined,
    strategy: StoredLaunchPayload["workspaceStrategy"],
  ) {
    return database.mutate(current.id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* pendingHandoffHolds(sql, ownerToken, current, handoff.id))) return undefined;
        if (!intactPayload(handoff)) throw Error("Invalid handoff payload");
        const target = JSON.parse(handoff.target_json) as StoredTarget;
        const message = (JSON.parse(handoff.payload_json) as { message: string }).message;
        const activationId = yield* newId;
        const [block] = yield* sql<{
          public_id: string;
        }>`SELECT public_id FROM run_blocks WHERE run_id=${current.id} AND block_id=${handoff.block_id}`;
        const launched = workerLaunchPayload(
          current.definitions,
          handoff.block_id,
          target,
          handoff.request_key,
          current.number,
          block!.public_id,
          strategy,
        );
        const plan = {
          activationId,
          requestKey: handoff.request_key,
          inputFingerprint: fingerprint(launched.message),
        };
        yield* createActivation(sql, current.id, handoff.block_id, yield* now, plan, handoff.cause);
        if (previousVisit) {
          yield* sql`UPDATE activation_messages SET accepted_json=${previousVisit.accepted_json} WHERE activation_id=${plan.activationId}`;
          yield* sql`INSERT INTO repeated_visits(activation_id,original_activation_id) VALUES(${plan.activationId},${previousVisit.original_id})`;
          yield* sql`UPDATE run_activations SET phase='finished' WHERE id=${previousVisit.id}`;
          yield* sql`UPDATE operation_intents SET target_json=${JSON.stringify({ ...target, threadId: previousVisit.thread_id })} WHERE id=${handoff.id}`;
        }
        const kind: DeliveryKind = previousVisit ? "send" : "launch";
        const body = JSON.stringify(
          previousVisit
            ? workerRevisitPayload(
                target,
                previousVisit.thread_id,
                handoff.request_key,
                message,
                block!.public_id,
              )
            : launched,
        );
        yield* sql`UPDATE operation_intents SET kind=${kind},payload_json=${body},fingerprint=${fingerprint(body)} WHERE id=${handoff.id} AND kind='handoff' AND state='pending'`;
        yield* clearSpentWaitMessages(sql, current.id);
        yield* advanceGeneration(sql, current.id);
        const [delivery] =
          yield* sql<DeliveryRecord>`SELECT * FROM operation_intents WHERE id=${handoff.id}`;
        return delivery && asDelivery(delivery);
      }),
    );
  }

  /** Turns a Handoff to a Human step into a Human occurrence that appears with its attention.
   * `generation`, when given, is the snapshot at which the caller read its Final result released.
   * Guards: owner, open gate, the Handoff's authorization context is live and that generation
   * holds; the Handoff is still pending. A Handoff whose stored context cannot be verified fails
   * the transition. Sets the Human step waiting, appends "Human waiting" and advances the
   * generation. */
  function handoffToHumanOccurrence(
    runRow: RunRow,
    handoff: Handoff,
    generation: number | undefined,
  ) {
    return database.mutate(runRow.id, (sql) =>
      Effect.gen(function* () {
        const arriving = yield* arrivingHandoff(sql, ownerToken, runRow.id, handoff, generation);
        if (!arriving) return;
        const id = yield* newId,
          time = yield* now;
        const context = arriving.message;
        yield* sql`INSERT INTO human_occurrences(id,run_id,block_id,incoming_intent_id,pending_context,appeared_at) VALUES(${id},${runRow.id},${handoff.block_id},${handoff.id},${context},${time})`;
        yield* sql`UPDATE operation_intents SET state='acknowledged',payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${handoff.id}`;
        yield* writeBlockState(sql, { runId: runRow.id, blockId: handoff.block_id }, "waiting", {
          freshness: "fresh",
          observed_at: time,
        });
        yield* appendTimelineEvent(sql, {
          kind: "human-waiting",
          runId: runRow.id,
          blockId: handoff.block_id,
          occurrenceId: id,
          observedAt: time,
        });
        yield* raiseHumanAttention(sql, runRow.id, handoff.block_id, id, time);
        yield* clearSpentWaitMessages(sql, runRow.id);
        yield* advanceGeneration(sql, runRow.id);
      }),
    );
  }

  return { arrivalAt, handoffToActivation, handoffToHumanOccurrence };
}

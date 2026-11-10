import { effectiveExits } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import { newId } from "../../ids.ts";
import { failure } from "../../result.ts";
import type { RunRow } from "../runner-types.ts";
import { runTarget } from "../runner-utils.ts";
import { now } from "../../time.ts";
import { requestReportPayload } from "../worker-payloads.ts";
import { settleAttention } from "./attention.ts";
import { blockHasUnresolvedWork, createDelivery } from "./deliveries.ts";
import { guardsHold } from "./guards.ts";
import { settleReportRejections } from "./report-diagnostics.ts";
import type { RunnerDatabase } from "./database.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** A Request report the caller checked against Run detail read at `generation` and T3. */
type RequestReport = {
  readonly blockId: string;
  readonly threadId: string;
  /** The completed run of the worker thread the report is requested for. */
  readonly executionId: string;
  /** The Block's current activation, which must still have no result. */
  readonly activationId: string;
  readonly generation: number;
};

/** A Request report link whose recovery chain ended in `executionId`'s report. */
export type RequestReportSettlement = {
  readonly intentId: string;
  readonly attentionId: string | null;
  readonly blockId: string;
  readonly executionId: string;
};

export function openRunRequestReport(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** Accepts a Request report: a send delivery to the Block's idle worker thread, linked to the
   * requested run and to its pending missing-report Problem. A link already recorded for that run
   * answers accepted. Guards: owner, not Archived, `current`'s authorization context is live and
   * the gate is open; then the request's generation holds, the Block's run is still the completed
   * one on that thread, its activation has no result and no Handoff or delivery is unresolved on
   * the Block. Appends "report recovery requested" and advances the generation. */
  function acceptRequestReport(current: RunRow, request: RequestReport) {
    const { blockId, threadId, executionId } = request;
    return database.mutate(current.id, (sql) =>
      Effect.gen(function* () {
        const existing =
          yield* sql`SELECT intent_id FROM report_recoveries WHERE run_id=${current.id} AND block_id=${blockId} AND source_execution_id=${executionId}`;
        if (existing.length) return { ok: true as const, value: undefined };
        if (!(yield* database.runHeldUnderContext(sql, current, true)))
          return failure("conflict", "The Run is stopped, closed, or its authorization changed.");
        const eligible =
          yield* sql`SELECT r.id FROM runs r JOIN run_blocks b ON b.run_id=r.id JOIN run_executions e ON e.run_id=r.id AND e.block_id=b.block_id AND e.execution_id=b.execution_id
        WHERE r.id=${current.id} AND r.generation=${request.generation} AND b.block_id=${blockId} AND b.execution_id=${executionId} AND e.engine_status='completed' AND e.thread_id=${threadId}
        AND NOT EXISTS(SELECT 1 FROM runtime_reports WHERE activation_id=${request.activationId})`;
        if (!eligible.length || (yield* blockHasUnresolvedWork(sql, current.id, blockId)))
          return failure(
            "conflict",
            "The Run changed or has competing work. Refresh before requesting a report.",
          );
        const intentId = yield* newId,
          key = yield* newId,
          time = yield* now;
        const [block] = yield* sql<{
          public_id: string;
        }>`SELECT public_id FROM run_blocks WHERE run_id=${current.id} AND block_id=${blockId}`;
        const [problem] = yield* sql<{
          id: string;
        }>`SELECT id FROM run_attention WHERE run_id=${current.id} AND block_id=${blockId} AND kind='missing-report' AND execution_id=${executionId} AND settled_at IS NULL`;
        const { definitions } = current;
        const exits = effectiveExits(
          definitions.flow.graph.blocks.find((block) => block.id === blockId)!,
          definitions.agents,
        );
        yield* createDelivery(sql, {
          id: intentId,
          runId: current.id,
          blockId,
          kind: "send",
          cause: "recovery:" + intentId,
          target: { ...runTarget(current), blockId, threadId },
          requestKey: key,
          payload: requestReportPayload(
            { environmentId: current.environment_id },
            threadId,
            key,
            exits,
            block!.public_id,
          ),
          contextId: current.context_id,
          retryScope: null,
        });
        yield* sql`INSERT INTO report_recoveries(intent_id,attention_id,run_id,block_id,source_execution_id,requested_at,thread_scope) VALUES(${intentId},${problem?.id ?? null},${current.id},${blockId},${executionId},${time},${threadId})`;
        yield* appendTimelineEvent(sql, {
          kind: "report-recovery-requested",
          runId: current.id,
          blockId,
          executionId,
          intentId,
          observedAt: time,
        });
        yield* advanceGeneration(sql, current.id);
        return { ok: true as const, value: undefined };
      }),
    );
  }

  /** Settles Request report links whose recovery chain ended in a report, with their missing-report
   * Problems and the Blocks' rejection diagnostics. `generation` is the Run detail snapshot the
   * chains were followed in. Guards: owner, not Archived, `current`'s authorization context is
   * live, the gate is open and that generation holds. Advances the generation. */
  const settleRequestReportLinks = (
    current: RunRow,
    generation: number,
    settlements: readonly RequestReportSettlement[],
  ) =>
    database.mutate(current.id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, current.id, {
          owner: true,
          notArchived: true,
          liveContext: current.context_id,
          gateOpen: true,
          generation,
        });
        if (!held) return;
        const time = yield* now;
        for (const recovery of settlements) {
          yield* settleReportRejections(sql, current.id, recovery.blockId, time);
          yield* sql`UPDATE report_recoveries SET settled_at=${time} WHERE intent_id=${recovery.intentId} AND settled_at IS NULL`;
          if (!recovery.attentionId) continue;
          const pending = yield* sql<{
            id: string;
          }>`SELECT id FROM run_attention WHERE id=${recovery.attentionId} AND settled_at IS NULL`;
          yield* settleAttention(
            sql,
            pending.map((matter) => ({
              id: matter.id,
              runId: current.id,
              blockId: recovery.blockId,
              executionId: recovery.executionId,
            })),
            "recovered-by:" + recovery.executionId,
            time,
          );
        }
        yield* advanceGeneration(sql, current.id);
      }),
    );

  return { acceptRequestReport, settleRequestReportLinks };
}

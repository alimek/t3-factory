import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";

/** A decision made from an earlier read of the Run is refused once its generation moves. */
export function advanceGeneration(sql: SqlClient.SqlClient, runId: string) {
  return sql`UPDATE runs SET generation=generation+1 WHERE id=${runId}`;
}

/** A Run timeline event by kind; its stored source key (the idempotency key) is derived here. */
export type TimelineEvent = { readonly runId: string; readonly observedAt: string } & (
  | { readonly kind: "run-settled"; readonly cause: "automatic" | "manual" }
  | { readonly kind: "run-activated"; readonly blockId: string; readonly reportId?: string }
  | { readonly kind: "run-archived" }
  | { readonly kind: "operation-cancelled"; readonly blockId: string; readonly intentId: string }
  | { readonly kind: "human-cancelled"; readonly blockId: string; readonly occurrenceId: string }
  | {
      readonly kind: "attention-appeared";
      readonly blockId: string;
      readonly executionId: string;
      readonly attentionId: string;
    }
  | { readonly kind: "attention-appeared"; readonly blockId: string; readonly occurrenceId: string }
  | {
      readonly kind: "attention-settled";
      readonly blockId: string;
      readonly executionId: string;
      readonly attentionId: string;
      readonly bindingId?: string;
    }
  | { readonly kind: "attention-settled"; readonly blockId: string; readonly occurrenceId: string }
  | {
      readonly kind: "report-accepted" | "working-reported";
      readonly blockId: string;
      readonly executionId: string | null;
      readonly reportId: string;
    }
  | {
      readonly kind: "handoff-held" | "handoff-created";
      readonly blockId: string;
      readonly cause: string;
      readonly intentId: string;
    }
  | { readonly kind: "human-answered"; readonly blockId: string; readonly occurrenceId: string }
);

type StoredEvent = {
  blockId: string | null;
  executionId: string | null;
  bindingId?: string;
  sourceKey: string;
  causeId: string | null;
};

function stored(event: TimelineEvent) {
  return Effect.gen(function* (): Effect.fn.Return<StoredEvent> {
    switch (event.kind) {
      case "run-settled":
        return {
          blockId: null,
          executionId: null,
          sourceKey: "settled:" + (yield* newId),
          causeId: event.cause,
        };
      case "run-activated":
        return {
          blockId: event.blockId,
          executionId: null,
          sourceKey: "activated:" + (yield* newId),
          causeId: event.reportId ?? null,
        };
      case "run-archived":
        return { blockId: null, executionId: null, sourceKey: "archived", causeId: null };
      case "operation-cancelled":
        return {
          blockId: event.blockId,
          executionId: null,
          sourceKey: "cancelled:" + event.intentId,
          causeId: event.intentId,
        };
      case "human-cancelled":
        return {
          blockId: event.blockId,
          executionId: null,
          sourceKey: "human-cancelled:" + event.occurrenceId,
          causeId: event.occurrenceId,
        };
      case "attention-appeared":
        return "occurrenceId" in event
          ? {
              blockId: event.blockId,
              executionId: null,
              sourceKey: "human-attention:" + event.occurrenceId,
              causeId: event.occurrenceId,
            }
          : {
              blockId: event.blockId,
              executionId: event.executionId,
              sourceKey: "attention:" + event.attentionId,
              causeId: event.attentionId,
            };
      case "attention-settled":
        return "occurrenceId" in event
          ? {
              blockId: event.blockId,
              executionId: null,
              sourceKey: "human-settled:" + event.occurrenceId,
              causeId: event.occurrenceId,
            }
          : {
              blockId: event.blockId,
              executionId: event.executionId,
              ...(event.bindingId === undefined ? {} : { bindingId: event.bindingId }),
              sourceKey: "attention-settled:" + event.attentionId,
              causeId: event.attentionId,
            };
      case "report-accepted":
      case "working-reported":
        return {
          blockId: event.blockId,
          executionId: event.executionId,
          sourceKey: (event.kind === "report-accepted" ? "report:" : "working:") + event.reportId,
          causeId: event.reportId,
        };
      case "handoff-held":
      case "handoff-created":
        return {
          blockId: event.blockId,
          executionId: null,
          sourceKey: event.cause,
          causeId: event.intentId,
        };
      case "human-answered":
        return {
          blockId: event.blockId,
          executionId: null,
          sourceKey: "human-answer:" + event.occurrenceId,
          causeId: event.occurrenceId,
        };
    }
  });
}

export function appendTimelineEvent(sql: SqlClient.SqlClient, event: TimelineEvent) {
  return Effect.gen(function* () {
    const { blockId, executionId, bindingId, sourceKey, causeId } = yield* stored(event);
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at) VALUES(${event.runId},${blockId},${executionId},${bindingId ?? null},${event.kind},${sourceKey},${causeId},${event.observedAt})`;
  });
}

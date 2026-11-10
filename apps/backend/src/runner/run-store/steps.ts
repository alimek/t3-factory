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
      readonly kind: "attention-settled";
      readonly blockId: string;
      readonly executionId: string;
      readonly attentionId: string;
    }
);

type StoredEvent = {
  blockId: string | null;
  executionId: string | null;
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
      case "attention-settled":
        return {
          blockId: event.blockId,
          executionId: event.executionId,
          sourceKey: "attention-settled:" + event.attentionId,
          causeId: event.attentionId,
        };
    }
  });
}

export function appendTimelineEvent(sql: SqlClient.SqlClient, event: TimelineEvent) {
  return Effect.gen(function* () {
    const { blockId, executionId, sourceKey, causeId } = yield* stored(event);
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${event.runId},${blockId},${executionId},${event.kind},${sourceKey},${causeId},${event.observedAt})`;
  });
}

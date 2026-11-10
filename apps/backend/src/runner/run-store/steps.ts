import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../../ids.ts";

/** A decision made from an earlier read of the Run is refused once its generation moves. */
export function advanceGeneration(sql: SqlClient.SqlClient, runId: string) {
  return sql`UPDATE runs SET generation=generation+1 WHERE id=${runId}`;
}

/** A Run timeline event by kind; its stored source key (the idempotency key) is derived here. */
export type TimelineEvent = { readonly runId: string; readonly observedAt: string } & (
  | { readonly kind: "started" }
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
  | { readonly kind: "human-waiting"; readonly blockId: string; readonly occurrenceId: string }
  | {
      readonly kind: "wait-started" | "wait-forwarded" | "wait-cancelled";
      readonly blockId: string;
      readonly arrivalId: string;
    }
  | {
      readonly kind: "handoff-released" | "operation-unresolved";
      readonly blockId: string;
      readonly intentId: string;
    }
  | {
      /** About the delivery that reached a Continuation: it waits behind the prompt, the prompt
       * visit's response went out, or it passed through unchanged. */
      readonly kind: "continuation-queued" | "continuation-forwarded" | "continuation-passed";
      readonly blockId: string;
      readonly intentId: string;
    }
  | {
      readonly kind: "send-acknowledged" | "launch-acknowledged" | "continuation-prompt-sent";
      readonly blockId: string;
      readonly executionId: string;
      readonly intentId: string;
      readonly engineStatus: string;
    }
  | {
      readonly kind: "report-recovery-requested";
      readonly blockId: string;
      readonly executionId: string;
      readonly intentId: string;
    }
  | {
      readonly kind: "execution-observed";
      readonly blockId: string;
      readonly executionId: string;
      readonly bindingId: string;
      readonly engineStatus: string;
    }
);

type StoredEvent = {
  blockId: string | null;
  executionId: string | null;
  bindingId?: string;
  engineStatus?: string;
  sourceKey: string;
  causeId: string | null;
};

/** Events about one Handoff or delivery, keyed by it. */
type DeliveryEvent = Extract<TimelineEvent, { readonly intentId: string }>;

function storedDeliveryEvent(event: DeliveryEvent) {
  return Effect.gen(function* (): Effect.fn.Return<StoredEvent> {
    const about = { blockId: event.blockId, executionId: null, causeId: event.intentId };
    switch (event.kind) {
      case "operation-cancelled":
        return { ...about, sourceKey: "cancelled:" + event.intentId };
      case "handoff-held":
      case "handoff-created":
        return { ...about, sourceKey: event.cause };
      case "handoff-released":
        return { ...about, sourceKey: "release:" + event.intentId };
      case "operation-unresolved":
        return { ...about, sourceKey: yield* newId };
      case "report-recovery-requested":
        return {
          ...about,
          executionId: event.executionId,
          sourceKey: "recovery:" + event.intentId,
        };
      case "continuation-queued":
      case "continuation-forwarded":
      case "continuation-passed":
        return { ...about, sourceKey: `${event.kind}:${event.intentId}` };
      case "send-acknowledged":
      case "launch-acknowledged":
      case "continuation-prompt-sent":
        return {
          ...about,
          executionId: event.executionId,
          engineStatus: event.engineStatus,
          sourceKey: "ack:" + event.intentId,
        };
    }
  });
}

/** Events about one Wait arrival, keyed by it. */
type WaitEvent = Extract<TimelineEvent, { readonly arrivalId: string }>;

const storedWaitEvent = (event: WaitEvent): StoredEvent => ({
  blockId: event.blockId,
  executionId: null,
  sourceKey: `${event.kind}:${event.arrivalId}`,
  causeId: event.arrivalId,
});

function stored(event: Exclude<TimelineEvent, WaitEvent>) {
  return Effect.gen(function* (): Effect.fn.Return<StoredEvent> {
    if ("intentId" in event) return yield* storedDeliveryEvent(event);
    switch (event.kind) {
      case "started":
        return { blockId: null, executionId: null, sourceKey: "start", causeId: null };
      case "execution-observed":
        return {
          blockId: event.blockId,
          executionId: event.executionId,
          bindingId: event.bindingId,
          engineStatus: event.engineStatus,
          sourceKey: yield* newId,
          causeId: null,
        };
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
      case "human-answered":
      case "human-waiting":
        return {
          blockId: event.blockId,
          executionId: null,
          sourceKey:
            (event.kind === "human-answered" ? "human-answer:" : "human:") + event.occurrenceId,
          causeId: event.occurrenceId,
        };
    }
  });
}

/** "Handoff released" keeps main's idempotent write: its key is derived from the Handoff, so a
 * repeat is a no-op instead of aborting the release. Other kinds keep their plain insert. */
export function appendTimelineEvent(sql: SqlClient.SqlClient, event: TimelineEvent) {
  return Effect.gen(function* () {
    const { blockId, executionId, bindingId, engineStatus, sourceKey, causeId } =
      "arrivalId" in event ? storedWaitEvent(event) : yield* stored(event);
    yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,binding_id,kind,source_key,cause_id,observed_at,engine_status) VALUES(${event.runId},${blockId},${executionId},${bindingId ?? null},${event.kind},${sourceKey},${causeId},${event.observedAt},${engineStatus ?? null}) ${event.kind === "handoff-released" ? sql`ON CONFLICT DO NOTHING` : sql``}`;
  });
}

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { now } from "../time.ts";
import type { ConversationKey } from "./conversations.ts";

/** Why admitted work ended without its reply; each owes the thread a resend notice. */
export type Interruption = "interrupted" | "model-failed" | "timed-out";

/** A resend notice is dispatched only within this long of the original admission. */
const RESEND_NOTICE_MS = 15 * 60 * 1000;

export interface AdmissionMarker {
  readonly conversation: ConversationKey;
  readonly messageId: string;
  readonly requesterId: string;
  readonly generation: number;
  readonly admittedAt: number;
}

/** One thread's owed coalesced notice. */
export interface OwedNotice {
  readonly conversation: ConversationKey;
  readonly generations: readonly number[];
  readonly requesterIds: readonly string[];
  readonly reason: Interruption;
}

type MarkerRow = {
  thread_id: string;
  guild_id: string;
  parent_channel_id: string;
  requester_id: string;
  generation: number;
  interrupted: Interruption;
};

const PRIORITY: readonly Interruption[] = ["model-failed", "timed-out", "interrupted"];

/**
 * Content-free markers of admitted invocations whose interpretation has not finished. They hold
 * no text: a marker only lets Factory tell a thread, once, that work there was discarded, so
 * nothing is replayed after a restart, an interruption or a failure.
 */
export function pendingAdmissions(sql: SqlClient.SqlClient, applicationId: string) {
  return {
    add: (marker: AdmissionMarker) =>
      sql`INSERT INTO chat_pending_admissions (application_id,message_id,thread_id,guild_id,parent_channel_id,requester_id,generation,admitted_at)
        VALUES (${applicationId},${marker.messageId},${marker.conversation.threadId},${marker.conversation.guildId},
          ${marker.conversation.parentChannelId},${marker.requesterId},${marker.generation},${new Date(marker.admittedAt).toISOString()})
        ON CONFLICT DO NOTHING`,
    /** The interpretation ended and owes nothing. */
    settle: (messageId: string) =>
      sql`DELETE FROM chat_pending_admissions WHERE application_id=${applicationId} AND message_id=${messageId}`,
    interrupt: (messageIds: readonly string[], reason: Interruption) =>
      messageIds.length === 0
        ? Effect.void
        : sql`UPDATE chat_pending_admissions SET interrupted=${reason}
            WHERE application_id=${applicationId} AND message_id IN ${sql.in(messageIds)}`,
    /** Markers an earlier session or process left behind: their work was discarded with it. */
    interruptLeftovers: sql`UPDATE chat_pending_admissions SET interrupted='interrupted'
      WHERE application_id=${applicationId} AND interrupted IS NULL`,
    /**
     * The notices owed now, one per thread. Interrupted markers past the notice deadline are
     * dropped without a notice.
     */
    owed: Effect.gen(function* () {
      const at = Date.parse(yield* now);
      const deadline = new Date(at - RESEND_NOTICE_MS).toISOString();
      yield* sql`DELETE FROM chat_pending_admissions WHERE application_id=${applicationId}
        AND interrupted IS NOT NULL AND admitted_at<${deadline}`;
      const rows =
        yield* sql<MarkerRow>`SELECT thread_id,guild_id,parent_channel_id,requester_id,generation,interrupted
        FROM chat_pending_admissions WHERE application_id=${applicationId} AND interrupted IS NOT NULL
        ORDER BY admitted_at`;
      const threads = new Map<string, MarkerRow[]>();
      for (const row of rows)
        threads.set(row.thread_id, [...(threads.get(row.thread_id) ?? []), row]);
      return [...threads.values()].map((markers): OwedNotice => ({
        conversation: {
          applicationId,
          guildId: markers[0]!.guild_id,
          parentChannelId: markers[0]!.parent_channel_id,
          threadId: markers[0]!.thread_id,
        },
        generations: markers.map((marker) => marker.generation),
        requesterIds: markers.map((marker) => marker.requester_id),
        reason: PRIORITY.find((reason) => markers.some((marker) => marker.interrupted === reason))!,
      }));
    }),
    /** The thread's notice was sent, or is no longer owed. */
    noticed: (threadId: string) =>
      sql`DELETE FROM chat_pending_admissions WHERE application_id=${applicationId} AND thread_id=${threadId} AND interrupted IS NOT NULL`,
  };
}

/** Off discards unfinished work without notices, and re-enabling never revives them. */
export const forgetPendingAdmissions = (sql: SqlClient.SqlClient) =>
  sql`DELETE FROM chat_pending_admissions`;

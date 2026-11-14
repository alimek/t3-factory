import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ConversationGenerations, ConversationKey } from "./conversations.ts";

export type HandleKind = "run-search" | "run-read";

/** The interpretation a tool call belongs to. */
export interface HandleOwner {
  readonly conversation: ConversationKey;
  readonly generation: number;
  /** The admitted invocation whose interpretation runs the tool call. */
  readonly messageId: string;
}

/**
 * Handles to continue a read in the same conversation. A handle is an opaque name for stored
 * read parameters; it conveys no authority, so callers recheck access and the source on every
 * use. It is usable only in the conversation and generation that issued it, and only while the
 * issuing invocation is still being interpreted or its turn is retained: reset, expiry, clearing
 * and eviction all make it unusable.
 */
export function conversationHandles(
  sql: SqlClient.SqlClient,
  generations: ConversationGenerations,
) {
  return {
    issue: (owner: HandleOwner, kind: HandleKind, payload: unknown) =>
      Effect.gen(function* () {
        const handle = `${kind === "run-search" ? "s" : "r"}-${randomBytes(9).toString("base64url")}`;
        const { conversation } = owner;
        yield* sql`INSERT INTO chat_conversation_handles (application_id,thread_id,handle,generation,message_id,kind,payload_json)
          VALUES (${conversation.applicationId},${conversation.threadId},${handle},${owner.generation},${owner.messageId},${kind},${JSON.stringify(payload)})`;
        return handle;
      }),
    /** The parameters `handle` names for `owner`, or undefined when it is not usable there. */
    resolve: (owner: HandleOwner, kind: HandleKind, handle: string) =>
      Effect.gen(function* () {
        const { conversation } = owner;
        if (!(yield* generations.isCurrent(conversation, owner.generation))) return undefined;
        const [row] = yield* sql<{ payload_json: string }>`SELECT h.payload_json
          FROM chat_conversation_handles h
          WHERE h.application_id=${conversation.applicationId} AND h.thread_id=${conversation.threadId}
            AND h.handle=${handle} AND h.kind=${kind} AND h.generation=${owner.generation}
            AND (h.message_id=${owner.messageId} OR EXISTS (SELECT 1 FROM chat_conversation_turns t
              WHERE t.application_id=h.application_id AND t.thread_id=h.thread_id
                AND t.generation=h.generation AND t.message_id=h.message_id))`;
        return row ? (JSON.parse(row.payload_json) as unknown) : undefined;
      }),
  };
}

export type ConversationHandles = ReturnType<typeof conversationHandles>;

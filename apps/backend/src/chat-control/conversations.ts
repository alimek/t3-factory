import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { now } from "../time.ts";

/** One shared conversation: a Discord thread of the configured application in this installation. */
export interface ConversationKey {
  readonly applicationId: string;
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly threadId: string;
}

/**
 * Conversation generations. Everything a conversation records belongs to one generation; clearing
 * starts the next, so work admitted under an earlier generation is fenced from publishing or
 * recording into the current one.
 */
export function conversationGenerations(sql: SqlClient.SqlClient) {
  const generation = (key: ConversationKey) =>
    Effect.map(
      sql<{
        generation: number;
      }>`SELECT generation FROM chat_conversations WHERE application_id=${key.applicationId} AND thread_id=${key.threadId}`,
      ([row]) => row?.generation,
    );
  return {
    /** The current generation, starting the first one for a new thread. */
    open: (key: ConversationKey) =>
      Effect.gen(function* () {
        const startedAt = yield* now;
        yield* sql`INSERT INTO chat_conversations (application_id,thread_id,guild_id,parent_channel_id,generation,generation_started_at)
          VALUES (${key.applicationId},${key.threadId},${key.guildId},${key.parentChannelId},1,${startedAt})
          ON CONFLICT DO NOTHING`;
        return (yield* generation(key))!;
      }),
    /** Clears the shared conversation by starting its next generation. */
    clear: (key: ConversationKey) =>
      Effect.gen(function* () {
        const startedAt = yield* now;
        yield* sql`INSERT INTO chat_conversations (application_id,thread_id,guild_id,parent_channel_id,generation,generation_started_at)
          VALUES (${key.applicationId},${key.threadId},${key.guildId},${key.parentChannelId},1,${startedAt})
          ON CONFLICT DO UPDATE SET generation=generation+1,generation_started_at=excluded.generation_started_at`;
      }),
    /** Whether work admitted under `admitted` may still publish or record into the conversation. */
    isCurrent: (key: ConversationKey, admitted: number) =>
      Effect.map(generation(key), (current) => current === admitted),
  };
}

export type ConversationGenerations = ReturnType<typeof conversationGenerations>;

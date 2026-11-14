import type { JSONValue } from "ai";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { now } from "../time.ts";

/** One shared conversation: a Discord thread of the configured application in this installation. */
export interface ConversationKey {
  readonly applicationId: string;
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly threadId: string;
}

const HOUR_MS = 60 * 60 * 1000;
/** Retention bounds of one conversation generation. */
const RETENTION = {
  /** Cleared this long after the last admitted human invocation. */
  inactivityMs: 72 * HOUR_MS,
  /** Cleared this long after the generation started, regardless of activity. */
  generationAgeMs: 14 * 24 * HOUR_MS,
  turns: 40,
  /** UTF-8 bytes of admitted input, selected replies and published bot replies together. */
  textBytes: 24 * 1024,
} as const;

/** A compact Factory fact from one tool call of a turn: the call and a bounded handle of its result. */
export interface TurnFact {
  readonly tool: string;
  readonly input: JSONValue;
  readonly fact: JSONValue;
}

/** A human message the invoker explicitly selected by replying to it in the same thread. */
export interface SelectedReply {
  readonly authorId: string;
  readonly text: string;
}

/** One complete retained turn. */
export interface Turn {
  readonly turn: number;
  readonly messageId: string;
  readonly authorId: string;
  /** The admitted message text, an immutable snapshot. */
  readonly input: string;
  readonly selectedReply: SelectedReply | null;
  readonly facts: readonly TurnFact[];
  /** The bot reply Discord accepted. */
  readonly reply: string;
}

/** A notice owed with the next published reply; content-free. */
export type ConversationNotice = "cleared" | "evicted";

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
const textBytes = (turn: Omit<Turn, "turn">) =>
  utf8(turn.input) + utf8(turn.selectedReply?.text ?? "") + utf8(turn.reply);

type TurnRow = {
  turn: number;
  message_id: string;
  author_id: string;
  input: string;
  quote_author_id: string | null;
  quote: string | null;
  facts_json: string;
  reply: string;
  text_bytes: number;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Conversation generations and their retained turns. Everything a conversation records belongs
 * to one generation; clearing deletes its turns and starts the next generation, so work admitted
 * under an earlier one is fenced from publishing or recording into the current one. Expiry is
 * applied from SQLite on every use, so it holds across restarts.
 */
export function conversationGenerations(sql: SqlClient.SqlClient) {
  const row = (key: ConversationKey) =>
    Effect.map(
      sql<{
        generation: number;
        generation_started_at: string;
        last_admitted_at: string | null;
        notice: ConversationNotice | null;
      }>`SELECT generation,generation_started_at,last_admitted_at,notice FROM chat_conversations WHERE application_id=${key.applicationId} AND thread_id=${key.threadId}`,
      ([found]) => found,
    );

  /** Clears every conversation whose generation has expired at `at`. */
  const expire = (at: number) =>
    clearWhere(
      sql,
      sql.or([
        sql`generation_started_at<=${iso(at - RETENTION.generationAgeMs)}`,
        sql`COALESCE(last_admitted_at,generation_started_at)<=${iso(at - RETENTION.inactivityMs)}`,
      ]),
      at,
    );

  const isCurrent = (key: ConversationKey, admitted: number) =>
    Effect.gen(function* () {
      yield* expire(Date.parse(yield* now));
      return (yield* row(key))?.generation === admitted;
    });

  return {
    /** The current generation, starting the first one for a new thread or after expiry. */
    open: (key: ConversationKey) =>
      Effect.gen(function* () {
        const startedAt = yield* now;
        yield* expire(Date.parse(startedAt));
        yield* sql`INSERT INTO chat_conversations (application_id,thread_id,guild_id,parent_channel_id,generation,generation_started_at)
          VALUES (${key.applicationId},${key.threadId},${key.guildId},${key.parentChannelId},1,${startedAt})
          ON CONFLICT DO NOTHING`;
        return (yield* row(key))!.generation;
      }),
    /** Records that `generation` admitted a human invocation into interpretation now. */
    admitted: (key: ConversationKey, generation: number) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`UPDATE chat_conversations SET last_admitted_at=${at}
          WHERE application_id=${key.applicationId} AND thread_id=${key.threadId} AND generation=${generation}`;
      }),
    /**
     * Clears the shared conversation by an explicit reset: its turns are deleted and the next
     * generation starts. The reset is acknowledged at once, so no notice is owed.
     */
    clear: (key: ConversationKey) =>
      Effect.gen(function* () {
        const startedAt = yield* now;
        yield* sql`INSERT INTO chat_conversations (application_id,thread_id,guild_id,parent_channel_id,generation,generation_started_at)
          VALUES (${key.applicationId},${key.threadId},${key.guildId},${key.parentChannelId},1,${startedAt})
          ON CONFLICT DO UPDATE SET generation=generation+1,generation_started_at=excluded.generation_started_at,last_admitted_at=NULL,notice=NULL`;
        yield* sql`DELETE FROM chat_conversation_turns WHERE application_id=${key.applicationId} AND thread_id=${key.threadId}`;
      }),
    /** Whether work admitted under `admitted` may still publish or record into the conversation. */
    isCurrent,
    /** The retained turns of `generation`, oldest first, and the notice owed with the next reply. */
    history: (key: ConversationKey, generation: number) =>
      Effect.gen(function* () {
        if (!(yield* isCurrent(key, generation))) return undefined;
        const rows = yield* sql<TurnRow>`SELECT * FROM chat_conversation_turns
          WHERE application_id=${key.applicationId} AND thread_id=${key.threadId} AND generation=${generation}
          ORDER BY turn`;
        return {
          turns: rows.map((turn): Turn => ({
            turn: turn.turn,
            messageId: turn.message_id,
            authorId: turn.author_id,
            input: turn.input,
            selectedReply:
              turn.quote_author_id !== null && turn.quote !== null
                ? { authorId: turn.quote_author_id, text: turn.quote }
                : null,
            facts: JSON.parse(turn.facts_json) as TurnFact[],
            reply: turn.reply,
          })),
          notice: (yield* row(key))!.notice,
        };
      }),
    /**
     * Records a turn whose reply Discord accepted, when `generation` is still current. Turns up to
     * `evictedThrough` were left out of the request for its budget and are evicted; then the oldest
     * whole turns go until the conversation is within its retention bounds. The notice the reply
     * carried is settled, and a new eviction owes the next reply its notice.
     */
    record: (
      key: ConversationKey,
      generation: number,
      turn: Omit<Turn, "turn">,
      evictedThrough: number | undefined,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* isCurrent(key, generation))) {
            // Cleared after this reply went out: the next reply still owes the cleared notice.
            yield* sql`UPDATE chat_conversations SET notice='cleared'
              WHERE application_id=${key.applicationId} AND thread_id=${key.threadId} AND notice IS NULL`;
            return false;
          }
          const where = sql.and([
            sql`application_id=${key.applicationId}`,
            sql`thread_id=${key.threadId}`,
          ]);
          if (evictedThrough !== undefined)
            yield* sql`DELETE FROM chat_conversation_turns WHERE ${where} AND turn<=${evictedThrough}`;
          const [last] = yield* sql<{
            turn: number | null;
          }>`SELECT MAX(turn) AS turn FROM chat_conversation_turns WHERE ${where}`;
          yield* sql`INSERT INTO chat_conversation_turns (application_id,thread_id,generation,turn,message_id,author_id,input,quote_author_id,quote,facts_json,reply,text_bytes)
            VALUES (${key.applicationId},${key.threadId},${generation},${(last?.turn ?? 0) + 1},${turn.messageId},${turn.authorId},${turn.input},
              ${turn.selectedReply?.authorId ?? null},${turn.selectedReply?.text ?? null},${JSON.stringify(turn.facts)},${turn.reply},${textBytes(turn)})`;
          const kept = yield* sql<{ turn: number; text_bytes: number }>`SELECT turn,text_bytes
            FROM chat_conversation_turns WHERE ${where} ORDER BY turn DESC`;
          let bytes = 0;
          const evicted = kept.filter((row, index) => {
            bytes += row.text_bytes;
            return index >= RETENTION.turns || bytes > RETENTION.textBytes;
          });
          if (evicted.length > 0)
            yield* sql`DELETE FROM chat_conversation_turns WHERE ${where} AND turn<=${evicted[0]!.turn}`;
          yield* sql`UPDATE chat_conversations SET notice=${evicted.length > 0 ? "evicted" : null} WHERE ${where}`;
          return true;
        }),
      ),
    /** Clears every expired conversation now; also applied on every other use. */
    expire: Effect.flatMap(now, (at) => expire(Date.parse(at))),
  };
}

/**
 * Clears the matching conversations: their turns are deleted, the next generation starts and the
 * next reply carries a content-free notice when context was lost. Use inside the transaction of
 * the change that requires it.
 */
export const clearConversations = (
  sql: SqlClient.SqlClient,
  scope: { readonly parentChannelIds: readonly string[] } | "all",
) =>
  Effect.gen(function* () {
    if (scope !== "all" && scope.parentChannelIds.length === 0) return;
    yield* clearWhere(
      sql,
      scope === "all" ? sql.and([]) : sql`parent_channel_id IN ${sql.in(scope.parentChannelIds)}`,
      Date.parse(yield* now),
    );
  });

function clearWhere(sql: SqlClient.SqlClient, condition: Statement.Fragment, at: number) {
  return Effect.gen(function* () {
    const cleared = yield* sql<{
      application_id: string;
      thread_id: string;
    }>`SELECT application_id,thread_id FROM chat_conversations WHERE ${condition}`;
    for (const { application_id, thread_id } of cleared) {
      const where = sql.and([sql`application_id=${application_id}`, sql`thread_id=${thread_id}`]);
      const [retained] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM chat_conversation_turns WHERE ${where}`;
      yield* sql`DELETE FROM chat_conversation_turns WHERE ${where}`;
      // A conversation that retained nothing keeps whatever notice it already owed.
      yield* sql`UPDATE chat_conversations SET generation=generation+1,generation_started_at=${iso(at)},last_admitted_at=NULL,
        notice=${retained!.count > 0 ? sql`'cleared'` : sql`notice`} WHERE ${where}`;
    }
  });
}

export type ConversationGenerations = ReturnType<typeof conversationGenerations>;

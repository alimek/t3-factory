import type { StateAdapter } from "chat";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

type Run = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;

const unused = (what: string) => () =>
  Promise.reject(
    new Error(
      `Chat control keeps no Chat SDK ${what}: Factory serializes each conversation itself and discards unfinished work on restart.`,
    ),
  );

/**
 * Chat SDK state in Factory's migration-owned SQLite: thread subscriptions and the key-value cache
 * with expiry that message deduplication and turn markers use. Factory runs the SDK with its
 * `concurrent` strategy and serializes conversations itself, because the SDK queue merges queued
 * messages and its drop strategy loses admitted ones; the SDK's locks, lists and queues are
 * therefore never needed and fail loudly instead of holding state outside SQLite.
 */
export function sqliteChatState(sql: SqlClient.SqlClient, run: Run): StateAdapter {
  const expiresAt = (ttlMs?: number) => (ttlMs === undefined ? null : Date.now() + ttlMs);
  const live = () => sql`DELETE FROM chat_sdk_cache WHERE expires_at IS NOT NULL AND expires_at<=${Date.now()}`;
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    subscribe: (threadId) =>
      run(sql`INSERT INTO chat_sdk_subscriptions (thread_id) VALUES (${threadId}) ON CONFLICT DO NOTHING`).then(
        () => undefined,
      ),
    unsubscribe: (threadId) =>
      run(sql`DELETE FROM chat_sdk_subscriptions WHERE thread_id=${threadId}`).then(() => undefined),
    isSubscribed: (threadId) =>
      run(
        Effect.map(
          sql`SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id=${threadId}`,
          (rows) => rows.length > 0,
        ),
      ),
    get: <T>(key: string) =>
      run(
        Effect.map(
          sql<{
            value_json: string;
          }>`SELECT value_json FROM chat_sdk_cache WHERE cache_key=${key} AND (expires_at IS NULL OR expires_at>${Date.now()})`,
          ([row]) => (row ? (JSON.parse(row.value_json) as T) : null),
        ),
      ),
    set: (key, value, ttlMs) =>
      run(
        Effect.andThen(
          live(),
          sql`INSERT INTO chat_sdk_cache (cache_key,value_json,expires_at) VALUES (${key},${JSON.stringify(value)},${expiresAt(ttlMs)})
            ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at`,
        ),
      ).then(() => undefined),
    delete: (key) => run(sql`DELETE FROM chat_sdk_cache WHERE cache_key=${key}`).then(() => undefined),
    setIfNotExists: (key, value, ttlMs) =>
      run(
        Effect.andThen(
          live(),
          Effect.map(
            sql`INSERT INTO chat_sdk_cache (cache_key,value_json,expires_at) VALUES (${key},${JSON.stringify(value)},${expiresAt(ttlMs)})
              ON CONFLICT(cache_key) DO NOTHING RETURNING cache_key`,
            (rows) => rows.length > 0,
          ),
        ),
      ),
    acquireLock: unused("locks"),
    extendLock: unused("locks"),
    releaseLock: unused("locks"),
    forceReleaseLock: unused("locks"),
    appendToList: unused("lists"),
    getList: unused("lists"),
    enqueue: unused("queues"),
    dequeue: unused("queues"),
    queueDepth: unused("queues"),
  };
}

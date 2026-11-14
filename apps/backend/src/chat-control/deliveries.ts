import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type {
  ChatDeliveryDiagnostics,
  ChatDeliveryProblem,
  Result,
  RetryChatDeliveryInput,
} from "@t3-factory/contracts";
import { newId } from "../ids.ts";
import { failure } from "../result.ts";
import { now } from "../time.ts";

/** Where a Factory message goes: a thread and the parent channel whose Access grants it. */
export interface Destination {
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly threadId: string;
}

/** A requester-bound confirmation button carried by the last message of a review. */
export interface ConfirmationButton {
  readonly customId: string;
  readonly label: string;
}

/** How the operating session creates one Factory message; resolves with Discord's message ID. */
export interface DiscordSender {
  readonly applicationId: string;
  readonly create: (
    destination: Destination,
    text: string,
    button?: ConfirmationButton,
  ) => Promise<string>;
}

/**
 * What a failed create proves. Discord answered with a definite refusal: `transient` for rate
 * limiting, which may be retried after a wait, `rejected` for anything that needs correction.
 * `unknown` when no answer proves whether Discord created the message: a lost connection, a
 * server error or an unreadable success.
 */
export type SendFailure = "transient" | "rejected" | "unknown";

export function sendFailure(error: unknown): SendFailure {
  const status =
    typeof error === "object" &&
    error !== null &&
    "originalError" in error &&
    typeof error.originalError === "object" &&
    error.originalError !== null &&
    "status" in error.originalError
      ? error.originalError.status
      : undefined;
  if (typeof status !== "number" || status >= 500) return "unknown";
  return status === 429 ? "transient" : "rejected";
}

const PROBLEM_LIMIT = 20;
const MAX_BACKOFF_MS = 300_000;
/** Waits after definite transient rejections: 1 s doubling to five minutes. */
const backoffMs = (attempts: number) =>
  Math.min(1000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

const PROBLEMS: Record<SendFailure, string> = {
  transient: "Discord asked Factory to slow down. Factory retries automatically.",
  rejected:
    "Discord refused the message. Check that the thread still exists, is not locked or archived beyond reach, and that the bot can view it and send messages there, then retry.",
  unknown: "Factory cannot tell whether Discord created the message. Retrying may post it twice.",
};

const INTERRUPTED =
  "Factory stopped while sending the message, so it cannot tell whether Discord created it. Retrying may post it twice.";

type DeliveryRow = {
  id: string;
  purpose: ChatDeliveryProblem["purpose"];
  guild_id: string;
  parent_channel_id: string;
  thread_id: string;
  project_ids_json: string;
  text: string;
  state: "owed" | "sending" | "delivered" | "failed" | "unknown" | "cancelled";
  attempts: number;
  next_attempt_at: string | null;
  problem: string | null;
  problem_at: string | null;
};

/** One message owed to a destination, recorded inside the transaction of the fact it reports. */
export interface OwedDelivery {
  readonly purpose: ChatDeliveryProblem["purpose"];
  readonly actionId: string | null;
  readonly destination: Destination;
  readonly projectIds: readonly string[];
  readonly text: string;
}

export const oweDelivery = (sql: SqlClient.SqlClient, owed: OwedDelivery) =>
  Effect.gen(function* () {
    const id = yield* newId;
    const createdAt = yield* now;
    const { destination } = owed;
    yield* sql`INSERT INTO chat_deliveries (id,purpose,action_id,guild_id,parent_channel_id,thread_id,project_ids_json,text,state,created_at)
      VALUES (${id},${owed.purpose},${owed.actionId},${destination.guildId},${destination.parentChannelId},${destination.threadId},
        ${JSON.stringify(owed.projectIds)},${owed.text},'owed',${createdAt})`;
  });

/** The Projects a parent channel grants now, to any allowed user. */
const channelGrants = (sql: SqlClient.SqlClient, parentChannelId: string) =>
  Effect.map(
    sql<{ project_id: string }>`SELECT g.project_id FROM chat_access_channel_projects g
      JOIN projects p ON p.id=g.project_id WHERE g.channel_id=${parentChannelId}`,
    (rows) => new Set(rows.map((row) => row.project_id)),
  );

/** Whether current Access still lets the delivery's channel receive content about its Projects. */
const destinationPermitted = (sql: SqlClient.SqlClient, row: DeliveryRow) =>
  Effect.map(channelGrants(sql, row.parent_channel_id), (granted) =>
    (JSON.parse(row.project_ids_json) as string[]).every((id) => granted.has(id)),
  );

/**
 * Cancels the undelivered debt of destinations an Access save no longer permits: their channel
 * is gone or no longer grants a Project the message concerns. Call inside the Access transaction.
 * A message already being sent may finish; the action it reports stays recorded.
 */
export const cancelRevokedDeliveries = (
  sql: SqlClient.SqlClient,
  channels: readonly { readonly channelId: string; readonly projectIds: readonly string[] }[],
) =>
  Effect.gen(function* () {
    const open = yield* sql<
      Pick<DeliveryRow, "id" | "parent_channel_id" | "project_ids_json">
    >`SELECT id,parent_channel_id,project_ids_json FROM chat_deliveries WHERE state IN ('owed','failed','unknown')`;
    const revoked = open.filter((row) => {
      const channel = channels.find((entry) => entry.channelId === row.parent_channel_id);
      return (
        !channel ||
        (JSON.parse(row.project_ids_json) as string[]).some(
          (id) => !channel.projectIds.includes(id),
        )
      );
    });
    if (revoked.length > 0)
      yield* sql`UPDATE chat_deliveries SET state='cancelled',next_attempt_at=NULL WHERE id IN ${sql.in(revoked.map((row) => row.id))}`;
  });

const problemOf = (row: DeliveryRow): ChatDeliveryProblem => ({
  id: row.id,
  purpose: row.purpose,
  state: row.state === "owed" ? "retrying" : (row.state as "failed" | "unknown"),
  guildId: row.guild_id,
  parentChannelId: row.parent_channel_id,
  threadId: row.thread_id,
  message: row.problem!,
  occurredAt: row.problem_at!,
  nextAttemptAt: row.state === "owed" ? row.next_attempt_at : null,
});

/**
 * Chat control's owed Discord messages. Each create is preceded by its persisted intent, a
 * definite transient rejection retries with backoff, a definite refusal waits for correction and
 * Retry, and a create Factory cannot prove either way is never repeated automatically: only the
 * host's warned Retry sends it again, one attempt at a time. Delivery is attempted only while a
 * verified session operates, and never changes the action it reports.
 */
export const makeChatDeliveries = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    /** Wakes the serving session's dispatcher, while one serves. */
    let wake: (() => void) | undefined;

    // A create interrupted by a stop or crash cannot be proven either way.
    const interruptedAt = yield* now;
    yield* sql`UPDATE chat_deliveries SET state='unknown',problem=${INTERRUPTED},problem_at=${interruptedAt} WHERE state='sending'`;

    const record = (id: string, fields: Partial<DeliveryRow> & Pick<DeliveryRow, "state">) =>
      Effect.gen(function* () {
        const at = yield* now;
        const problem = fields.problem ?? null;
        yield* sql`UPDATE chat_deliveries SET state=${fields.state},next_attempt_at=${fields.next_attempt_at ?? null},
          problem=${problem},problem_at=${problem === null ? null : at} WHERE id=${id}`;
      });

    /** One attempt for one owed delivery. */
    const attempt = (sender: DiscordSender, row: DeliveryRow) =>
      Effect.gen(function* () {
        if (!(yield* destinationPermitted(sql, row))) {
          yield* sql`UPDATE chat_deliveries SET state='cancelled',next_attempt_at=NULL WHERE id=${row.id}`;
          return;
        }
        const attempts = row.attempts + 1;
        // Intent before the create: a crash from here on leaves an unknown delivery, never a
        // silent repeat.
        yield* sql`UPDATE chat_deliveries SET state='sending',attempts=${attempts} WHERE id=${row.id} AND state='owed'`;
        const sent = yield* Effect.result(
          Effect.tryPromise(() =>
            sender.create(
              {
                guildId: row.guild_id,
                parentChannelId: row.parent_channel_id,
                threadId: row.thread_id,
              },
              row.text,
            ),
          ),
        );
        if (sent._tag === "Success") {
          yield* sql`UPDATE chat_deliveries SET state='delivered',message_id=${sent.success},sent_by_application_id=${sender.applicationId},
            next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${row.id}`;
          return;
        }
        const failed = sendFailure(sent.failure.cause);
        if (failed === "transient") {
          const next = new Date(Date.parse(yield* now) + backoffMs(attempts)).toISOString();
          return yield* record(row.id, {
            state: "owed",
            next_attempt_at: next,
            problem: PROBLEMS.transient,
          });
        }
        yield* record(row.id, {
          state: failed === "rejected" ? "failed" : "unknown",
          problem: PROBLEMS[failed],
        });
      });

    /** Attempts every due delivery once; the time of the next due attempt, if any. */
    const deliverDue = (sender: DiscordSender) =>
      Effect.gen(function* () {
        const at = yield* now;
        const due = yield* sql<DeliveryRow>`SELECT * FROM chat_deliveries
          WHERE state='owed' AND (next_attempt_at IS NULL OR next_attempt_at<=${at}) ORDER BY created_at`;
        for (const row of due) yield* attempt(sender, row);
        const [next] = yield* sql<{
          at: string | null;
        }>`SELECT MIN(next_attempt_at) AS at FROM chat_deliveries WHERE state='owed'`;
        return next?.at ?? null;
      });

    /**
     * The serving session's dispatcher: delivers what is due now, then waits for the next due
     * attempt or a wake-up. It ends with the session's scope.
     */
    const serve = (sender: DiscordSender) =>
      Effect.gen(function* () {
        let signal = yield* Deferred.make<void>();
        const notify = () => Deferred.doneUnsafe(signal, Effect.void);
        wake = notify;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (wake === notify) wake = undefined;
          }),
        );
        for (;;) {
          signal = yield* Deferred.make<void>();
          const next = yield* deliverDue(sender);
          const waitMs = next === null ? undefined : Date.parse(next) - Date.parse(yield* now);
          if (waitMs !== undefined && waitMs <= 0) continue;
          yield* Deferred.await(signal).pipe(
            waitMs === undefined
              ? (effect) => effect
              : Effect.timeoutOption(Duration.millis(waitMs)),
          );
        }
      });

    const diagnostics = Effect.gen(function* (): Effect.fn.Return<
      Omit<ChatDeliveryDiagnostics, "reconciling">,
      unknown
    > {
      const rows = yield* sql<DeliveryRow>`SELECT * FROM chat_deliveries
        WHERE state IN ('failed','unknown') OR (state='owed' AND problem IS NOT NULL)
        ORDER BY problem_at DESC, id LIMIT ${PROBLEM_LIMIT + 1}`;
      const [count] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM chat_deliveries
        WHERE state IN ('failed','unknown') OR (state='owed' AND problem IS NOT NULL)`;
      return {
        problems: rows.slice(0, PROBLEM_LIMIT).map(problemOf),
        moreProblems: Math.max(0, count!.count - PROBLEM_LIMIT),
      };
    });

    /**
     * The host's explicit Retry of one delivery that needs it: a definitely refused one after
     * correction, or one Factory cannot prove either way once the owner accepted a possible
     * duplicate. It schedules exactly one new attempt and never repeats the reported action.
     */
    const retry = (input: RetryChatDeliveryInput, operating: boolean) =>
      Effect.gen(function* (): Effect.fn.Return<Result<undefined>, unknown> {
        if (!operating)
          return failure("conflict", "Turn Chat control on before retrying a delivery.");
        const [row] =
          yield* sql<DeliveryRow>`SELECT * FROM chat_deliveries WHERE id=${input.deliveryId}`;
        if (!row || (row.state !== "failed" && row.state !== "unknown"))
          return failure("conflict", "This message no longer needs a Retry.");
        if (row.state === "unknown" && !input.duplicateRiskAccepted)
          return failure(
            "validation",
            "Discord may already show this message. Accept that Retry can post it twice.",
            [
              {
                code: "chat_delivery_duplicate_risk",
                path: "duplicateRiskAccepted",
                message: "Accept that Retry can post this message twice.",
              },
            ],
          );
        if (!(yield* destinationPermitted(sql, row))) {
          yield* sql`UPDATE chat_deliveries SET state='cancelled',next_attempt_at=NULL WHERE id=${row.id}`;
          return failure(
            "conflict",
            "Access no longer permits this destination; the message was cancelled.",
          );
        }
        yield* sql`UPDATE chat_deliveries SET state='owed',next_attempt_at=NULL,problem=NULL,problem_at=NULL
          WHERE id=${row.id} AND state=${row.state}`;
        wake?.();
        return { ok: true, value: undefined };
      });

    return {
      serve,
      /** New debt was recorded; the serving session delivers it now. */
      wake: Effect.sync(() => wake?.()),
      diagnostics,
      retry,
    };
  });

export type ChatDeliveries = Effect.Success<ReturnType<typeof makeChatDeliveries>>;

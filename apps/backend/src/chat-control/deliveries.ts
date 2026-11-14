import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
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
import type { ConfirmationButton, DisabledButton } from "./confirmation-buttons.ts";
import { catchUpNotices } from "./report-notices.ts";
import { withApplicationNotice } from "./status-cards.ts";

/** Where a Factory message goes: a thread and the parent channel whose Access grants it. */
export interface Destination {
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly threadId: string;
}

/**
 * How the operating session sends Factory messages: `create` resolves with Discord's message ID
 * and asks Discord to enforce the create's `nonce`, `edit` replaces a message's text, `disable`
 * replaces a review's button with a disabled one, `reopen` unarchives an archived thread unless
 * Discord shows it locked, which Factory never undoes, and `locked` reads whether moderators
 * locked the thread.
 */
export interface DiscordSender {
  readonly applicationId: string;
  readonly create: (
    destination: Destination,
    text: string,
    options: { readonly nonce: string; readonly button?: ConfirmationButton },
  ) => Promise<string>;
  readonly edit: (destination: Destination, messageId: string, text: string) => Promise<void>;
  readonly disable: (
    destination: Destination,
    messageId: string,
    customId: string,
    state: DisabledButton,
  ) => Promise<void>;
  readonly reopen: (destination: Destination) => Promise<"open" | "reopened" | "locked">;
  readonly locked: (destination: Destination) => Promise<boolean>;
}

/**
 * What a failed create proves. Discord answered with a definite refusal: `transient` for rate
 * limiting, which may be retried after a wait, `rejected` for anything that needs correction.
 * `unknown` when no answer proves whether Discord created the message: a lost connection, a
 * server error or an unreadable success.
 */
type SendFailure = "transient" | "rejected" | "unknown";

/** Discord's HTTP status and JSON error code of a failed request, as the adapter kept them. */
function discordError(error: unknown): { status?: number; code?: number } {
  const original =
    typeof error === "object" && error !== null && "originalError" in error
      ? (error.originalError as { status?: unknown; code?: unknown } | null)
      : null;
  return {
    ...(typeof original?.status === "number" ? { status: original.status } : {}),
    ...(typeof original?.code === "number" ? { code: original.code } : {}),
  };
}

function sendFailure(error: unknown): SendFailure {
  const { status } = discordError(error);
  if (status === undefined || status >= 500) return "unknown";
  return status === 429 ? "transient" : "rejected";
}

/** Discord error codes whose correction Factory can name. */
const DISCORD_CODES = {
  unknownChannel: 10003,
  unknownMessage: 10008,
  archived: 50083,
  locked: 160005,
  activeThreads: 160006,
} as const;

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

/** Corrections Factory can name from Discord's error code; others get the general refusal. */
const CORRECTIONS: Partial<Record<number, string>> = {
  [DISCORD_CODES.unknownChannel]:
    "Discord does not show the thread to the bot: it was deleted or the bot lost access. Factory never recreates a thread or posts elsewhere. Restore the bot's access, then retry.",
  [DISCORD_CODES.locked]:
    "The thread is locked, and Factory never unlocks threads. Unlock it in Discord, then retry.",
  [DISCORD_CODES.activeThreads]:
    "Factory could not reopen the archived thread: the server reached Discord's active thread limit. Archive another thread, then retry.",
};

const EDIT_UNANSWERED = "Discord did not confirm the edit. Factory retries automatically.";
const REPLACEMENT_LOST =
  "Discord deleted this Run's replacement status card too. Factory does not create another on its own; Retry creates a new card.";

/** What a definite refusal asks the owner to correct. */
const correction = (error: unknown) =>
  CORRECTIONS[discordError(error).code ?? 0] ?? PROBLEMS.rejected;

const INTERRUPTED =
  "Factory stopped while sending the message, so it cannot tell whether Discord created it. Retrying may post it twice.";

type DeliveryRow = {
  id: string;
  purpose: ChatDeliveryProblem["purpose"];
  run_id: string | null;
  guild_id: string;
  parent_channel_id: string;
  thread_id: string;
  project_ids_json: string;
  text: string;
  state: "owed" | "sending" | "delivered" | "failed" | "unknown" | "cancelled" | "lost" | "retired";
  attempts: number;
  next_attempt_at: string | null;
  problem: string | null;
  problem_at: string | null;
  message_id: string | null;
  sent_by_application_id: string | null;
};

/** One Discord request of a delivery attempt; failures carry the adapter's error as `cause`. */
type Request = <A>(send: () => Promise<A>) => Effect.Effect<A, { readonly cause: unknown }>;

/** How long one delivery request may wait for Discord's answer, within Node's timer range. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Sends one request and waits for its answer or the timeout, without being interruptible: a
 * released session waits at most this long for a request already dispatched.
 */
const bounded: Request = <A>(send: () => Promise<A>) =>
  Effect.callback<A, { readonly cause: unknown }>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<A, { readonly cause: unknown }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(effect);
    };
    const timer = setTimeout(
      () => settle(Effect.fail({ cause: new Error("Discord did not answer in time.") })),
      REQUEST_TIMEOUT_MS,
    );
    send().then(
      (value) => settle(Effect.succeed(value)),
      (cause: unknown) => settle(Effect.fail({ cause })),
    );
  });

/** Re-attempts of an unproven create end after this many requests in all. */
const DEDUPLICATED_REQUESTS = 3;
/**
 * Discord returns the message an earlier create with the same nonce made, instead of creating
 * another, for a few minutes after it. Factory re-attempts only well inside that window.
 */
const DEDUPLICATION_WINDOW_MS = 60_000;

/** A stable nonce for one create intent, within Discord's 25 characters. */
export const nonceOf = (...intent: readonly string[]) =>
  createHash("sha256").update(intent.join("\n")).digest("hex").slice(0, 25);

/** How one create intent ended: Discord's message ID, or what its failure proves. */
type Created =
  | { readonly messageId: string }
  | { readonly failure: SendFailure; readonly cause: unknown };

/**
 * Creates one message under its intent's nonce. When no answer proves whether Discord created it,
 * Factory asks again with the same nonce, which Discord enforces: it returns the message the
 * earlier request created instead of creating another. At most two re-attempts, within one minute
 * of the first request. Once any request was unproven, only a message ID reconciles its outcome;
 * a later refusal still leaves that earlier create unknown. Re-attempts stop when the session is released,
 * so another session never repeats an unproven create on its own.
 */
export const createDeduplicated = (
  sender: DiscordSender,
  destination: Destination,
  text: string,
  nonce: string,
  button?: ConfirmationButton,
) =>
  Effect.gen(function* (): Effect.fn.Return<Created> {
    const firstAt = yield* Clock.currentTimeMillis;
    let unproven = false;
    for (let requests = 1; ; requests++) {
      const sent = yield* Effect.result(
        bounded(() =>
          sender.create(destination, text, { nonce, ...(button === undefined ? {} : { button }) }),
        ),
      );
      if (sent._tag === "Success") return { messageId: sent.success };
      const failure = sendFailure(sent.failure.cause);
      if (failure === "rejected" || (failure === "transient" && !unproven))
        return { failure: unproven ? "unknown" : failure, cause: sent.failure.cause };
      unproven = true;
      const elapsed = (yield* Clock.currentTimeMillis) - firstAt;
      if (requests >= DEDUPLICATED_REQUESTS || elapsed >= DEDUPLICATION_WINDOW_MS)
        return { failure: "unknown", cause: sent.failure.cause };
      // A released session's interruption arrives here, before any re-attempt.
      yield* Effect.interruptible(Effect.void);
    }
  });

const destinationOf = (row: DeliveryRow): Destination => ({
  guildId: row.guild_id,
  parentChannelId: row.parent_channel_id,
  threadId: row.thread_id,
});

/**
 * A serving session's wakeable loop: `run` performs `pass`, then waits until the time it returns
 * (null: until woken) or a wake-up, and repeats until the session's scope ends. `wake` reaches
 * only a running loop.
 */
export const wakeableLoop = () => {
  let wake: (() => void) | undefined;
  const run = <E, R>(pass: Effect.Effect<string | null, E, R>) =>
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
        const next = yield* pass;
        const waitMs =
          next === null ? undefined : Date.parse(next) - (yield* Clock.currentTimeMillis);
        if (waitMs !== undefined && waitMs <= 0) continue;
        yield* Deferred.await(signal).pipe(
          waitMs === undefined ? (effect) => effect : Effect.timeoutOption(Duration.millis(waitMs)),
        );
      }
    });
  return { run, wake: () => wake?.() };
};

/** One message owed to a destination, recorded inside the transaction of the fact it reports. */
export interface OwedDelivery {
  readonly purpose: "receipt";
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
export const channelGrants = (sql: SqlClient.SqlClient, parentChannelId: string) =>
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
 * Retry, and a create Factory cannot prove either way is repeated automatically only under its
 * Discord-enforced nonce within the bounded deduplication window. Beyond that it is unknown: only
 * the host's warned Retry sends it again, one attempt at a time. Delivery is attempted only while a
 * verified session operates, and never changes the action it reports.
 */
export const makeChatDeliveries = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    /** The serving session's dispatcher, while one serves. */
    const dispatcher = wakeableLoop();

    // An edit interrupted by a stop or crash is simply repeated; a create cannot be proven
    // either way.
    const interruptedAt = yield* now;
    yield* sql`UPDATE chat_deliveries SET state='owed' WHERE state='sending' AND message_id IS NOT NULL`;
    yield* sql`UPDATE chat_deliveries SET state='unknown',problem=${INTERRUPTED},problem_at=${interruptedAt} WHERE state='sending'`;

    const record = (id: string, fields: Partial<DeliveryRow> & Pick<DeliveryRow, "state">) =>
      Effect.gen(function* () {
        const at = yield* now;
        const problem = fields.problem ?? null;
        yield* sql`UPDATE chat_deliveries SET state=${fields.state},next_attempt_at=${fields.next_attempt_at ?? null},
          problem=${problem},problem_at=${problem === null ? null : at} WHERE id=${id}`;
      });

    /** Owed again after a wait: 1 s doubling to five minutes over consecutive attempts. */
    const later = (id: string, attempts: number, problem: string) =>
      Effect.gen(function* () {
        const next = new Date(Date.parse(yield* now) + backoffMs(attempts)).toISOString();
        yield* record(id, { state: "owed", next_attempt_at: next, problem });
      });

    /** Delivered `sent`; owed again when the text changed while it was being sent. */
    const delivered = (row: DeliveryRow, messageId: string, applicationId: string) =>
      sql`UPDATE chat_deliveries SET state=CASE WHEN text=${row.text} THEN 'delivered' ELSE 'owed' END,
        message_id=${messageId},sent_by_application_id=${applicationId},attempts=0,
        next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${row.id}`;

    /** The text a delivery should show now; captures may have changed it since it was read. */
    const currentText = (id: string) =>
      Effect.map(
        sql<{ text: string }>`SELECT text FROM chat_deliveries WHERE id=${id}`,
        ([row]) => row!.text,
      );

    /** A new card message in the same lineage, owed or awaiting the host's Retry. */
    const replacementCard = (row: DeliveryRow, text: string, problem: string | null) =>
      Effect.gen(function* () {
        const id = yield* newId;
        const createdAt = yield* now;
        yield* sql`INSERT INTO chat_deliveries (id,purpose,run_id,guild_id,parent_channel_id,thread_id,project_ids_json,text,state,problem,problem_at,created_at)
          VALUES (${id},'status-card',${row.run_id},${row.guild_id},${row.parent_channel_id},${row.thread_id},${row.project_ids_json},
            ${text},${problem === null ? "owed" : "failed"},${problem},${problem === null ? null : createdAt},${createdAt})`;
        return id;
      });

    /**
     * Discord proved the message deleted; it stays recorded as provenance. A status card's
     * lineage replaces it automatically once; after that a new card waits for the host's Retry.
     * A notice is never recreated: its pending matters stay on the card.
     */
    const messageLost = (row: DeliveryRow) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE chat_deliveries SET state='lost',next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${row.id}`;
          const [card] = yield* sql<{
            replacement_used: number;
          }>`SELECT replacement_used FROM chat_status_cards WHERE delivery_id=${row.id}`;
          if (!card) return;
          const id = yield* replacementCard(
            row,
            yield* currentText(row.id),
            card.replacement_used === 1 ? REPLACEMENT_LOST : null,
          );
          yield* sql`UPDATE chat_status_cards SET delivery_id=${id},replacement_used=1 WHERE delivery_id=${row.id}`;
        }),
      );

    /**
     * Another application posted the message, so this one cannot edit it. It stays as
     * provenance; a Run that still warrants a card gets a new one explaining the change once,
     * while a notice's edit is simply no longer owed.
     */
    const messageRetired = (row: DeliveryRow) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE chat_deliveries SET state='retired',next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${row.id}`;
          const [card] = yield* sql<{
            reportable: number;
          }>`SELECT reportable FROM chat_status_cards WHERE delivery_id=${row.id}`;
          if (card?.reportable !== 1) return;
          const id = yield* replacementCard(
            row,
            withApplicationNotice(yield* currentText(row.id)),
            null,
          );
          yield* sql`UPDATE chat_status_cards SET delivery_id=${id},replaced_application_id=${row.sent_by_application_id}
            WHERE delivery_id=${row.id}`;
        }),
      );

    /**
     * Edits a known message. Discord refuses edits in an archived thread; once a fresh read shows
     * it archived and not locked, Factory reopens it and edits again, posting nothing to wake it.
     */
    const edit = (sender: DiscordSender, row: DeliveryRow, request: Request) =>
      Effect.gen(function* (): Effect.fn.Return<{ readonly failure?: unknown }> {
        const destination = destinationOf(row);
        const once = request(() => sender.edit(destination, row.message_id!, row.text)).pipe(
          Effect.as({}),
          Effect.catch((failure) => Effect.succeed({ failure: failure.cause })),
        );
        const first = yield* once;
        if (!("failure" in first) || discordError(first.failure).code !== DISCORD_CODES.archived)
          return first;
        const reopened = yield* Effect.result(request(() => sender.reopen(destination)));
        if (reopened._tag === "Failure") return { failure: reopened.failure.cause };
        if (reopened.success === "locked")
          return { failure: { originalError: { status: 403, code: DISCORD_CODES.locked } } };
        return yield* once;
      });

    /** One attempt to bring a known message to its current text. Edits are safe to repeat. */
    const attemptEdit = (sender: DiscordSender, row: DeliveryRow, request: Request) =>
      Effect.gen(function* () {
        const attempts = row.attempts + 1;
        yield* sql`UPDATE chat_deliveries SET state='sending',attempts=${attempts} WHERE id=${row.id} AND state='owed'`;
        const edited = yield* edit(sender, row, request);
        if (!("failure" in edited))
          return yield* delivered(row, row.message_id!, sender.applicationId);
        const { status, code } = discordError(edited.failure);
        if (status === 404 && code === DISCORD_CODES.unknownMessage) return yield* messageLost(row);
        if (status === undefined || status >= 500)
          return yield* later(row.id, attempts, EDIT_UNANSWERED);
        if (status === 429) return yield* later(row.id, attempts, PROBLEMS.transient);
        yield* record(row.id, { state: "failed", problem: correction(edited.failure) });
      });

    /**
     * One attempt for one owed delivery. A dispatched request finishes even when its session is
     * released meanwhile, so whatever Discord answered is recorded; each request is bounded, and
     * an unanswered create is unknown while an unanswered edit is simply repeated later.
     */
    const attempt = (sender: DiscordSender, row: DeliveryRow) =>
      Effect.uninterruptible(attemptOnce(sender, row, bounded));

    const attemptOnce = (sender: DiscordSender, row: DeliveryRow, request: Request) =>
      Effect.gen(function* () {
        if (!(yield* destinationPermitted(sql, row))) {
          yield* sql`UPDATE chat_deliveries SET state='cancelled',next_attempt_at=NULL WHERE id=${row.id}`;
          return;
        }
        if (row.message_id !== null)
          return yield* row.sent_by_application_id === sender.applicationId
            ? attemptEdit(sender, row, request)
            : messageRetired(row);
        // Discord accepts posts in a locked thread from a bot holding Manage Threads, but a lock
        // stops Factory's sends until moderators lift it. An unreadable state leaves the create
        // to classify its own refusal.
        const lock = yield* Effect.result(request(() => sender.locked(destinationOf(row))));
        if (lock._tag === "Success" && lock.success) {
          yield* record(row.id, { state: "failed", problem: CORRECTIONS[DISCORD_CODES.locked]! });
          return;
        }
        const attempts = row.attempts + 1;
        // Intent before the create: a crash from here on leaves an unknown delivery, never a
        // silent repeat.
        yield* sql`UPDATE chat_deliveries SET state='sending',attempts=${attempts} WHERE id=${row.id} AND state='owed'`;
        const sent = yield* createDeduplicated(
          sender,
          destinationOf(row),
          row.text,
          nonceOf("delivery", row.id),
        ).pipe(
          Effect.onInterrupt(() => record(row.id, { state: "unknown", problem: INTERRUPTED })),
        );
        if ("messageId" in sent) return yield* delivered(row, sent.messageId, sender.applicationId);
        if (sent.failure === "transient") return yield* later(row.id, attempts, PROBLEMS.transient);
        yield* record(row.id, {
          state: sent.failure === "rejected" ? "failed" : "unknown",
          problem: sent.failure === "rejected" ? correction(sent.cause) : PROBLEMS.unknown,
        });
      });

    /** Attempts every due delivery once; the time of the next due attempt, if any. */
    const deliverDue = (sender: DiscordSender) =>
      Effect.gen(function* () {
        const at = yield* now;
        const due = yield* sql<DeliveryRow>`SELECT * FROM chat_deliveries
          WHERE state='owed' AND (next_attempt_at IS NULL OR next_attempt_at<=${at}) ORDER BY created_at,rowid`;
        for (const row of due) yield* attempt(sender, row);
        const [next] = yield* sql<{
          at: string | null;
        }>`SELECT MIN(COALESCE(next_attempt_at,${at})) AS at FROM chat_deliveries WHERE state='owed'`;
        return next?.at ?? null;
      });

    /**
     * The serving session's dispatcher: delivers what is due now, then waits for the next due
     * attempt or a wake-up. It ends with the session's scope.
     */
    const serve = (sender: DiscordSender) =>
      Effect.gen(function* () {
        // Cards another application posted cannot be edited by this one: a Run that warrants a
        // card is owed a new one now, not only at its next change.
        yield* sql`UPDATE chat_deliveries SET state='owed',next_attempt_at=NULL WHERE purpose='status-card' AND state='delivered'
          AND sent_by_application_id<>${sender.applicationId}
          AND id IN (SELECT delivery_id FROM chat_status_cards WHERE reportable=1)`;
        // Notices that accrued while no session served are posted as one catch-up per Run.
        yield* catchUpNotices(sql, sender.applicationId);
        return yield* dispatcher.run(deliverDue(sender));
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
        dispatcher.wake();
        return { ok: true, value: undefined };
      });

    return {
      serve,
      /** New debt was recorded; the serving session delivers it now. */
      wake: Effect.sync(dispatcher.wake),
      diagnostics,
      retry,
    };
  });

export type ChatDeliveries = Effect.Success<ReturnType<typeof makeChatDeliveries>>;

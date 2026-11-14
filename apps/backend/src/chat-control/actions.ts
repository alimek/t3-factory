import { createHash } from "node:crypto";
import type { JSONValue } from "ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChatActionReconciliation } from "@t3-factory/contracts";
import { newId } from "../ids.ts";
import { now } from "../time.ts";
import { grantedProjects } from "./access.ts";
import type { ConversationKey } from "./conversations.ts";
import {
  oweDelivery,
  sendFailure,
  type ChatDeliveries,
  type Destination,
  type DiscordSender,
} from "./deliveries.ts";

/** The mutation kinds Chat control can propose; each has one shared Factory operation. */
export type ChatOperationName = "start";

/** A requester's confirmation lasts this long from the first dispatch of its button. */
const CONSENT_MS = 5 * 60_000;
/** The longest complete review, all parts together, in Unicode characters. */
export const REVIEW_CHARACTER_LIMIT = 32_000;
const BUTTON_PREFIX = "factory-confirm:";

/**
 * A mutation call Factory validated into an exact proposal: what would be performed, which
 * Projects it targets and the complete review Factory renders for it, as ordered message parts.
 */
export interface Proposed {
  readonly operation: ChatOperationName;
  /** The exact parameters a confirmation performs; immutable once proposed. */
  readonly parameters: JSONValue;
  readonly projectIds: readonly string[];
  readonly review: readonly string[];
  /** The confirmation button's label and the text of the message carrying it. */
  readonly confirmation: { readonly label: string; readonly text: string };
  /** Compact targets the turn retains as the proposal fact. */
  readonly targets: JSONValue;
  /** A pending proposal of the same requester and thread this one corrects. */
  readonly supersedes: string | undefined;
}

/** How performing a confirmed action ended, as the shared operation reported it. */
export type ActionOutcome =
  /** Accepted: `facts` are the actual accepted facts; `originRunId` a Run this context started. */
  | { readonly kind: "accepted"; readonly facts: JSONValue; readonly originRunId?: string }
  /** A definitive local rejection that proved no effect; the attempt is used up. */
  | { readonly kind: "rejected"; readonly facts: JSONValue }
  /** Unavailable before any decision, with no effect: the consent stays live. */
  | { readonly kind: "unavailable" }
  /** Whether the operation took effect is not established yet. */
  | { readonly kind: "unknown" };

/**
 * One mutation kind's binding to its shared Factory operation. `execute` performs the exact
 * parameters under the action's stable identity; `reconcile` only reads whether that identity
 * was accepted (`unavailable` proves it was not); `receipt` renders the deterministic result.
 */
export interface ChatOperation {
  readonly name: ChatOperationName;
  readonly execute: (
    actionId: string,
    parameters: JSONValue,
  ) => Effect.Effect<ActionOutcome, unknown>;
  readonly reconcile: (
    actionId: string,
    parameters: JSONValue,
  ) => Effect.Effect<ActionOutcome, unknown>;
  readonly receipt: (
    outcome: Extract<ActionOutcome, { facts: JSONValue }>,
    parameters: JSONValue,
  ) => string;
  /** One line for the requester's repeated click: what this decided outcome was. */
  readonly summary: (outcome: Extract<ActionOutcome, { facts: JSONValue }>) => string;
}

/** Where and for whom a proposal was made, from the admitted invocation. */
interface ProposalContext {
  readonly conversation: ConversationKey;
  readonly requesterId: string;
  readonly generation: number;
  readonly messageId: string;
  readonly toolCallId: string;
}

type ProposalState = "preparing" | "presented" | "accepting" | "consumed" | "ended";

type ProposalRow = {
  id: string;
  application_id: string;
  guild_id: string;
  parent_channel_id: string;
  thread_id: string;
  requester_id: string;
  operation: ChatOperationName;
  parameters_json: string;
  project_ids_json: string;
  state: ProposalState;
  ended_reason: "failed" | "superseded" | "revoked" | "application" | null;
  expires_at: string | null;
};

type ActionRow = {
  id: string;
  proposal_id: string;
  state: "accepting" | "accepted" | "rejected";
  started_at: string;
  outcome_json: string | null;
};

/** A proposal's current state as later turns see it: content-free facts, never a full review. */
export type ProposalStatus =
  | { readonly state: "awaiting-confirmation"; readonly expiresAt: string }
  | { readonly state: "expired" | "confirming" | "no-longer-valid" | "not-presented" }
  | { readonly state: "accepted" | "rejected"; readonly outcome: JSONValue };

/** A button click as Discord delivered it, with Factory's check of the clicker's access. */
export interface ConfirmationClick {
  readonly customId: string;
  readonly userId: string;
  readonly threadId: string;
  /** The verified application of the session that received the click. */
  readonly applicationId: string;
  /** Whether that session still operates: Chat control On and the session not released. */
  readonly operating: () => boolean;
  /** The clicker's current Discord access to the thread, checked only when needed. */
  readonly access: Effect.Effect<"permitted" | "denied" | "unavailable", unknown>;
}

export const isConfirmation = (customId: string) => customId.startsWith(BUTTON_PREFIX);

const REPLIES = {
  notYours:
    "Only the person who asked for this review can confirm it. Ask Factory for your own review.",
  invalid: "This confirmation is no longer valid. Ask Factory again for a new review.",
  expired:
    "This review expired five minutes after Factory posted it, so nothing was done. Ask Factory again for a new review.",
  denied: "Chat control does not accept this confirmation from you here.",
  unavailable:
    "Factory could not confirm your access to this thread, so nothing was done. Try the button again before the review expires.",
  confirming: "Factory is already working on this confirmation.",
  accepted: "Confirmed. Factory accepted it; the receipt follows in this thread.",
  rejected: "Confirmed, but Factory did not accept it; the receipt in this thread explains why.",
  notNow:
    "Factory could not act on this right now and did nothing. Try the button again before the review expires.",
  unknown:
    "Factory could not yet establish whether this was accepted. It will not perform it again; the receipt follows in this thread once Factory knows.",
} as const;

const PREPARATION_FAILED =
  "Factory could not post the complete review, so it cannot be confirmed. Ask again for a new review.";

const identityOf = (context: ProposalContext, proposed: Proposed) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        context.conversation.applicationId,
        context.conversation.threadId,
        context.requesterId,
        proposed.operation,
        proposed.parameters,
      ]),
    )
    .digest("hex");

const destinationOf = (row: ProposalRow): Destination => ({
  guildId: row.guild_id,
  parentChannelId: row.parent_channel_id,
  threadId: row.thread_id,
});

/** The clicker's answer for each way performing a confirmed action can end. */
const OUTCOME_REPLIES: Record<ActionOutcome["kind"], string> = {
  accepted: REPLIES.accepted,
  rejected: REPLIES.rejected,
  unavailable: REPLIES.notNow,
  unknown: REPLIES.unknown,
};

/**
 * Why a click cannot take this proposal's consent, before any check that needs Discord:
 * `repeated` when the proposal was already confirmed, so the requester gets its result.
 */
function clickRefusal(
  row: ProposalRow | undefined,
  click: ConfirmationClick,
): keyof typeof REPLIES | "repeated" | undefined {
  if (!row || row.application_id !== click.applicationId || row.thread_id !== click.threadId)
    return "invalid";
  if (row.requester_id !== click.userId) return "notYours";
  if (row.state === "accepting" || row.state === "consumed") return "repeated";
  return row.state === "presented" ? undefined : "invalid";
}

type StatusRow = ProposalRow & {
  action_state: ActionRow["state"] | null;
  outcome_json: string | null;
};

/** A proposal's state for later turns at epoch milliseconds `at`. */
function statusOf(row: StatusRow, at: number): ProposalStatus {
  switch (row.state) {
    case "consumed":
      return {
        state: row.action_state as "accepted" | "rejected",
        outcome: JSON.parse(row.outcome_json!) as JSONValue,
      };
    case "accepting":
      return { state: "confirming" };
    case "ended":
      return { state: row.ended_reason === "failed" ? "not-presented" : "no-longer-valid" };
    case "preparing":
      return { state: "not-presented" };
    case "presented":
      return at >= Date.parse(row.expires_at!)
        ? { state: "expired" }
        : { state: "awaiting-confirmation", expiresAt: row.expires_at! };
  }
}

/**
 * Chat control's shared review, consent, action and receipt path for every mutation kind.
 * A proposal records the exact operation and parameters with their requester and context. Its
 * review is published as complete ordered parts with the requester-bound button last; the button's
 * first dispatch fixes the five-minute expiry. Only the requester's click within that lifetime,
 * with Chat control On, the scope and application unchanged and current Discord access, consumes
 * it, and the shared operation runs under the action's stable identity, never inside a SQL
 * transaction. The decided outcome, the Run's originating thread and the owed receipt commit
 * together; an interrupted attempt reconciles the same identity and is never performed again.
 */
export function makeChatActions(
  sql: SqlClient.SqlClient,
  operations: readonly ChatOperation[],
  deliveries: ChatDeliveries,
) {
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  /** Actions this process is performing right now. */
  const performing = new Set<string>();

  const proposal = (id: string) =>
    Effect.map(sql<ProposalRow>`SELECT * FROM chat_proposals WHERE id=${id}`, ([row]) => row);
  const actionOf = (proposalId: string) =>
    Effect.map(
      sql<ActionRow>`SELECT * FROM chat_actions WHERE proposal_id=${proposalId}`,
      ([row]) => row,
    );
  const expired = (row: ProposalRow) =>
    Effect.map(
      Clock.currentTimeMillis,
      (at) => row.expires_at !== null && at >= Date.parse(row.expires_at),
    );

  /**
   * Records a proposal, or finds the identical one still waiting for this requester here: same
   * requester, context, operation and exact parameters keep their identity and expiry. A
   * correction ends the pending proposal it supersedes.
   */
  const open = (proposed: Proposed, context: ProposalContext) =>
    sql.withTransaction(
      Effect.gen(function* (): Effect.fn.Return<
        | { readonly kind: "new"; readonly id: string }
        | { readonly kind: "pending"; readonly id: string; readonly expiresAt: string },
        unknown
      > {
        const identity = identityOf(context, proposed);
        const at = yield* now;
        const [pending] = yield* sql<{
          id: string;
          expires_at: string;
        }>`SELECT id,expires_at FROM chat_proposals WHERE identity=${identity}
            AND state IN ('presented','accepting') AND expires_at>${at} ORDER BY expires_at DESC LIMIT 1`;
        if (pending) return { kind: "pending", id: pending.id, expiresAt: pending.expires_at };
        const { conversation } = context;
        if (proposed.supersedes !== undefined)
          yield* sql`UPDATE chat_proposals SET state='ended',ended_reason='superseded'
              WHERE id=${proposed.supersedes} AND application_id=${conversation.applicationId}
                AND thread_id=${conversation.threadId} AND requester_id=${context.requesterId}
                AND operation=${proposed.operation} AND state IN ('preparing','presented')`;
        const id = yield* newId;
        yield* sql`INSERT INTO chat_proposals (id,application_id,guild_id,parent_channel_id,thread_id,requester_id,operation,parameters_json,identity,project_ids_json,generation,message_id,tool_call_id,state,created_at)
            VALUES (${id},${conversation.applicationId},${conversation.guildId},${conversation.parentChannelId},${conversation.threadId},${context.requesterId},
              ${proposed.operation},${JSON.stringify(proposed.parameters)},${identity},${JSON.stringify(proposed.projectIds)},
              ${context.generation},${context.messageId},${context.toolCallId},'preparing',${at})`;
        return { kind: "new", id };
      }),
    );

  const fail = (id: string) =>
    sql`UPDATE chat_proposals SET state='ended',ended_reason='failed' WHERE id=${id} AND state IN ('preparing','presented')`;

  /**
   * Publishes a new proposal's complete review: every part in order, then the button. Consent
   * becomes usable only once every preceding part was delivered; the button's first dispatch
   * fixes the expiry even if its own delivery stays uncertain. A part that fails, or a button
   * Discord definitely refused, leaves no usable consent.
   */
  const present = (
    id: string,
    proposed: Proposed,
    sender: DiscordSender,
    destination: Destination,
  ) =>
    Effect.gen(function* (): Effect.fn.Return<"presented" | "failed", unknown> {
      for (const part of proposed.review) {
        const sent = yield* Effect.result(
          Effect.tryPromise(() => sender.create(destination, part)),
        );
        if (sent._tag === "Failure") {
          yield* fail(id);
          yield* Effect.ignore(
            Effect.tryPromise(() => sender.create(destination, PREPARATION_FAILED)),
          );
          return "failed";
        }
      }
      const expiresAt = new Date((yield* Clock.currentTimeMillis) + CONSENT_MS).toISOString();
      yield* sql`UPDATE chat_proposals SET state='presented',expires_at=${expiresAt} WHERE id=${id} AND state='preparing'`;
      const button = yield* Effect.result(
        Effect.tryPromise(() =>
          sender.create(destination, proposed.confirmation.text, {
            customId: `${BUTTON_PREFIX}${id}`,
            label: proposed.confirmation.label,
          }),
        ),
      );
      if (button._tag === "Failure" && sendFailure(button.failure.cause) !== "unknown") {
        yield* fail(id);
        yield* Effect.ignore(
          Effect.tryPromise(() => sender.create(destination, PREPARATION_FAILED)),
        );
        return "failed";
      }
      return "presented";
    });

  /** Commits a decided outcome: consumption, the action's result, origin and owed receipt. */
  const decide = (row: ProposalRow, actionId: string, outcome: ActionOutcome) =>
    Effect.gen(function* () {
      const operation = byName.get(row.operation)!;
      const parameters = JSON.parse(row.parameters_json) as JSONValue;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const decidedAt = yield* now;
          if (outcome.kind === "unavailable") {
            yield* sql`DELETE FROM chat_actions WHERE id=${actionId} AND state='accepting'`;
            yield* sql`UPDATE chat_proposals SET state='presented' WHERE id=${row.id} AND state='accepting'`;
            return;
          }
          if (outcome.kind === "unknown") return;
          yield* sql`UPDATE chat_actions SET state=${outcome.kind},decided_at=${decidedAt},outcome_json=${JSON.stringify(outcome.facts)}
              WHERE id=${actionId} AND state='accepting'`;
          yield* sql`UPDATE chat_proposals SET state='consumed' WHERE id=${row.id}`;
          if (outcome.kind === "accepted" && outcome.originRunId !== undefined)
            yield* sql`INSERT INTO chat_run_origins (run_id,application_id,guild_id,parent_channel_id,thread_id,action_id,recorded_at)
                VALUES (${outcome.originRunId},${row.application_id},${row.guild_id},${row.parent_channel_id},${row.thread_id},${actionId},${decidedAt})
                ON CONFLICT DO NOTHING`;
          yield* oweDelivery(sql, {
            purpose: "receipt",
            actionId,
            destination: destinationOf(row),
            projectIds: JSON.parse(row.project_ids_json) as string[],
            text: operation.receipt(outcome, parameters),
          });
        }),
      );
      if (outcome.kind === "accepted" || outcome.kind === "rejected") yield* deliveries.wake;
    });

  /** Performs a consumed proposal under its action identity, outside any transaction. */
  const perform = (row: ProposalRow, actionId: string) =>
    Effect.gen(function* () {
      performing.add(actionId);
      const operation = byName.get(row.operation)!;
      const parameters = JSON.parse(row.parameters_json) as JSONValue;
      const executed = yield* Effect.result(operation.execute(actionId, parameters));
      const outcome: ActionOutcome =
        executed._tag === "Success"
          ? executed.success
          : yield* Effect.orElseSucceed(operation.reconcile(actionId, parameters), () => ({
              kind: "unknown" as const,
            }));
      yield* decide(row, actionId, outcome);
      return outcome;
    }).pipe(
      Effect.uninterruptible,
      Effect.ensuring(Effect.sync(() => performing.delete(actionId))),
    );

  /** Reconciles an attempt whose outcome this process does not know, by its identity alone. */
  const reconcileAction = (row: ProposalRow, action: ActionRow) =>
    Effect.gen(function* () {
      const operation = byName.get(row.operation)!;
      const outcome = yield* Effect.orElseSucceed(
        operation.reconcile(action.id, JSON.parse(row.parameters_json) as JSONValue),
        () => ({ kind: "unknown" as const }),
      );
      yield* decide(row, action.id, outcome);
      return outcome;
    });

  const repeatedClick = (row: ProposalRow, click: ConfirmationClick) =>
    Effect.gen(function* () {
      const action = yield* actionOf(row.id);
      if (!action) return REPLIES.invalid;
      if (action.state === "accepting") {
        if (performing.has(action.id)) return REPLIES.confirming;
        return OUTCOME_REPLIES[(yield* reconcileAction(row, action)).kind];
      }
      // The decided result is shown only to its requester, here, with current access.
      if ((yield* click.access) !== "permitted") return REPLIES.denied;
      const operation = byName.get(row.operation)!;
      return `You already confirmed this review. ${operation.summary({
        kind: action.state,
        facts: JSON.parse(action.outcome_json!) as JSONValue,
      })}`;
    });

  /** Takes the consent for one attempt, if it is still live and its scope still holds. */
  const take = (row: ProposalRow) =>
    sql.withTransaction(
      Effect.gen(function* (): Effect.fn.Return<
        { readonly actionId: string } | { readonly refused: keyof typeof REPLIES },
        unknown
      > {
        const current = (yield* proposal(row.id))!;
        if (current.state === "accepting" || current.state === "consumed")
          return { refused: "confirming" };
        if (current.state !== "presented") return { refused: "invalid" };
        if (yield* expired(current)) return { refused: "expired" };
        const granted = yield* grantedProjects(
          sql,
          current.requester_id,
          current.parent_channel_id,
        );
        if ((JSON.parse(current.project_ids_json) as string[]).some((id) => !granted.includes(id)))
          return { refused: "denied" };
        const [configured] = yield* sql<{
          application_id: string | null;
        }>`SELECT application_id FROM chat_discord_connection WHERE singleton=1`;
        if (configured?.application_id !== current.application_id) return { refused: "invalid" };
        const actionId = yield* newId;
        const startedAt = yield* now;
        yield* sql`UPDATE chat_proposals SET state='accepting' WHERE id=${current.id} AND state='presented'`;
        yield* sql`INSERT INTO chat_actions (id,proposal_id,state,started_at) VALUES (${actionId},${current.id},'accepting',${startedAt})`;
        return { actionId };
      }),
    );

  /**
   * A confirmation button click; the ephemeral answer for the clicker. Wrong requester, wrong
   * context, denied or unavailable access never consume live consent.
   */
  const confirm = (click: ConfirmationClick) =>
    Effect.gen(function* (): Effect.fn.Return<string, unknown> {
      const row = yield* proposal(click.customId.slice(BUTTON_PREFIX.length));
      const refused = clickRefusal(row, click);
      if (refused === "repeated") return yield* repeatedClick(row!, click);
      if (refused) return REPLIES[refused];
      if (yield* expired(row!)) return REPLIES.expired;
      const access = yield* click.access;
      if (access !== "permitted") return REPLIES[access];
      // Chat control turned Off meanwhile: nothing is consumed and the consent stays live.
      if (!click.operating()) return REPLIES.notNow;
      const taken = yield* take(row!);
      if (!("refused" in taken))
        return OUTCOME_REPLIES[(yield* perform(row!, taken.actionId)).kind];
      return taken.refused === "confirming"
        ? yield* repeatedClick(row!, click)
        : REPLIES[taken.refused];
    });

  /**
   * Startup recovery: a review interrupted before its button was dispatched never becomes
   * usable, and every attempt left without an outcome reconciles its identity. An attempt proven
   * not accepted returns its consent, which still expires at its original time.
   */
  const recover = Effect.gen(function* () {
    yield* sql`UPDATE chat_proposals SET state='ended',ended_reason='failed' WHERE state='preparing'`;
    const open = yield* sql<ActionRow>`SELECT * FROM chat_actions WHERE state='accepting'`;
    for (const action of open) {
      const row = (yield* proposal(action.proposal_id))!;
      yield* reconcileAction(row, action);
    }
  });

  /** The current state of proposals later turns refer to. */
  const statuses = (ids: readonly string[]) =>
    Effect.gen(function* () {
      if (ids.length === 0) return new Map<string, ProposalStatus>();
      const at = yield* Clock.currentTimeMillis;
      const rows =
        yield* sql<StatusRow>`SELECT p.*,a.state AS action_state,a.outcome_json FROM chat_proposals p
          LEFT JOIN chat_actions a ON a.proposal_id=p.id WHERE p.id IN ${sql.in(ids)}`;
      return new Map(rows.map((row) => [row.id, statusOf(row, at)]));
    });

  /** Attempts whose outcome is still being reconciled, for Settings. */
  const reconciling = Effect.map(
    sql<ActionRow & { operation: ChatOperationName }>`SELECT a.*,p.operation FROM chat_actions a
        JOIN chat_proposals p ON p.id=a.proposal_id WHERE a.state='accepting' ORDER BY a.started_at`,
    (rows): ChatActionReconciliation[] =>
      rows
        .filter((row) => !performing.has(row.id))
        .map((row) => ({ id: row.id, operation: row.operation, startedAt: row.started_at })),
  );

  return { open, present, fail, confirm, recover, statuses, reconciling };
}

export type ChatActions = ReturnType<typeof makeChatActions>;

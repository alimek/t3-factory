import { createHash } from "node:crypto";
import type { JSONValue } from "ai";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChatActionOperation, ChatActionReconciliation } from "@t3-factory/contracts";
import type { StartAuthorization } from "../runner/runner-start.ts";
import { failure } from "../result.ts";
import { newId } from "../ids.ts";
import { now } from "../time.ts";
import { grantedProjects } from "./access.ts";
import type { ConversationKey } from "./conversations.ts";
import {
  BUTTON_PREFIX,
  confirmationButtons,
  type ConfirmationButton,
  type DisabledButton,
} from "./confirmation-buttons.ts";
import {
  createDeduplicated,
  nonceOf,
  oweDelivery,
  type ChatDeliveries,
  type Destination,
  type DiscordSender,
} from "./deliveries.ts";
import { characters } from "./interpretation.ts";
import { at } from "./status-cards.ts";

/** The mutation kinds Chat control can propose; each has one shared Factory operation. */
export type ChatOperationName = ChatActionOperation;

/** A requester's confirmation lasts this long from the first dispatch of its button. */
const CONSENT_MS = 5 * 60_000;
/** The longest complete review, all parts together, in Unicode characters. */
const REVIEW_CHARACTER_LIMIT = 32_000;

/** The text of a review's last message, which carries the button: who confirms, and until when. */
const confirmationText = (expiresAt: string) =>
  `🔒 Only the person who asked can confirm · expires ${at(expiresAt)}`;

/** The latest expiry whose Discord timestamp has as many digits as any expiry Factory posts. */
const LONGEST_EXPIRY = new Date(9_999_999_999_000).toISOString();

/** Whether a complete review, its button message included, exceeds what chat may present. */
export const exceedsReviewLimit = (review: readonly string[]) =>
  characters([...review, confirmationText(LONGEST_EXPIRY)].join("")) > REVIEW_CHARACTER_LIMIT;

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
  /** The confirmation button's label. */
  readonly confirmation: { readonly label: string };
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
    authorization: StartAuthorization,
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
  /** The primary target whose newer proposal corrects an older one: a Project, occurrence or Run. */
  readonly target: (parameters: JSONValue) => string;
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

/** The clicker's private feedback when a click does not change the button. */
const REPLIES = {
  notYours:
    "🔒 Only the person who asked for this review can confirm it. Ask Factory for your own.",
  invalid: "🚫 This confirmation is no longer valid. Ask Factory for a new review.",
  expired: "⌛ This review expired, so nothing was done. Ask Factory for a new review.",
  denied: "🚫 Chat control does not accept this confirmation from you here.",
  unavailable:
    "⚠️ Factory could not confirm your access to this thread, so nothing was done. Try again before the review expires.",
  confirming: "⏳ Factory is already working on this confirmation.",
  notNow:
    "⚠️ Factory could not act on this right now and did nothing. Try again before the review expires.",
  unknown:
    "❓ Factory cannot tell yet whether this was accepted. It will not perform it again; the receipt follows here once Factory knows.",
} as const;

/**
 * How Factory answers a confirmation click: privately to the clicker, or, once the click decided
 * the review, by disabling its button in place (the receipt follows in the thread).
 */
export type ClickAnswer =
  | { readonly kind: "ephemeral"; readonly text: string }
  | { readonly kind: "disable"; readonly customId: string; readonly state: DisabledButton };

const ephemeral = (text: string): ClickAnswer => ({ kind: "ephemeral", text });

const PREPARATION_FAILED =
  "⚠️ Factory could not post the complete review, so it cannot be confirmed. Ask again for a new review.";

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

/**
 * The clicker's answer for each way performing a confirmed action can end. A decided review's
 * button is disabled for everyone; consent that is still live or still being reconciled keeps
 * its button, so the requester can click again.
 */
const outcomeAnswer = (proposalId: string, kind: ActionOutcome["kind"]): ClickAnswer => {
  if (kind === "unavailable") return ephemeral(REPLIES.notNow);
  if (kind === "unknown") return ephemeral(REPLIES.unknown);
  return {
    kind: "disable",
    customId: `${BUTTON_PREFIX}${proposalId}`,
    state: kind === "accepted" ? "confirmed" : "invalid",
  };
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
  /** Told after a committed origin, so its Run's status card is captured now. */
  originRecorded: (runId: string) => void,
) {
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  const buttons = confirmationButtons(sql);
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

  const scopeGranted = (row: ProposalRow) =>
    Effect.map(grantedProjects(sql, row.requester_id, row.parent_channel_id), (granted) =>
      (JSON.parse(row.project_ids_json) as string[]).every((id) => granted.includes(id)),
    );

  /**
   * Records a proposal, or finds the identical one still waiting for this requester here: same
   * requester, context, operation and exact parameters keep their identity and expiry. Otherwise
   * it corrects every pending proposal of the same requester, context and operation for the same
   * primary target, whatever the model said, and the one `supersedes` names: they end as
   * superseded before the new review is presented. Expired and confirmed proposals stay as they are.
   */
  const open = (proposed: Proposed, context: ProposalContext) =>
    sql
      .withTransaction(
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
          const operation = byName.get(proposed.operation)!;
          const target = operation.target(proposed.parameters);
          const live = yield* sql<{
            id: string;
            parameters_json: string;
          }>`SELECT id,parameters_json FROM chat_proposals WHERE application_id=${conversation.applicationId}
            AND thread_id=${conversation.threadId} AND requester_id=${context.requesterId}
            AND operation=${proposed.operation} AND identity<>${identity}
            AND (state='preparing' OR (state='presented' AND expires_at>${at}))`;
          const corrected = live
            .filter(
              (row) =>
                row.id === proposed.supersedes ||
                operation.target(JSON.parse(row.parameters_json) as JSONValue) === target,
            )
            .map((row) => row.id);
          if (corrected.length > 0)
            yield* sql`UPDATE chat_proposals SET state='ended',ended_reason='superseded' WHERE id IN ${sql.in(corrected)}`;
          const id = yield* newId;
          yield* sql`INSERT INTO chat_proposals (id,application_id,guild_id,parent_channel_id,thread_id,requester_id,operation,parameters_json,identity,project_ids_json,generation,message_id,tool_call_id,state,created_at)
            VALUES (${id},${conversation.applicationId},${conversation.guildId},${conversation.parentChannelId},${conversation.threadId},${context.requesterId},
              ${proposed.operation},${JSON.stringify(proposed.parameters)},${identity},${JSON.stringify(proposed.projectIds)},
              ${context.generation},${context.messageId},${context.toolCallId},'preparing',${at})`;
          return { kind: "new", id };
        }),
      )
      .pipe(Effect.tap(() => buttons.changed));

  const fail = (id: string) =>
    sql`UPDATE chat_proposals SET state='ended',ended_reason='failed' WHERE id=${id} AND state IN ('preparing','presented')`;

  /** Whether the proposal is still being prepared and current Access still grants its targets. */
  const stillPreparing = (id: string, proposed: Proposed) =>
    Effect.gen(function* () {
      const row = yield* proposal(id);
      if (row?.state !== "preparing") return false;
      const granted = yield* grantedProjects(sql, row.requester_id, row.parent_channel_id);
      return proposed.projectIds.every((projectId) => granted.includes(projectId));
    });

  /**
   * Publishes a new proposal's complete review: every part in order, then the button. Before
   * each part and before the button, the proposal must still be preparing, current Access must
   * grant its targets and `permitted` (Chat control On, the requester's access and the
   * conversation generation) must hold; otherwise publication stops without a button. Consent
   * becomes usable only once every preceding part was delivered; the button's first dispatch
   * fixes the expiry even if its own delivery stays uncertain. A part that fails, or a button
   * Discord definitely refused, leaves no usable consent.
   */
  const present = (
    id: string,
    proposed: Proposed,
    sender: DiscordSender,
    destination: Destination,
    permitted: Effect.Effect<boolean, unknown>,
  ) =>
    Effect.gen(function* (): Effect.fn.Return<"presented" | "failed" | "withdrawn", unknown> {
      const create = (text: string, nonce: string, button?: ConfirmationButton) =>
        createDeduplicated(sender, destination, text, nonceOf("review", id, nonce), button);
      const failed = Effect.gen(function* () {
        yield* fail(id);
        yield* create(PREPARATION_FAILED, "failed");
        return "failed" as const;
      });
      const withdrawn = Effect.as(fail(id), "withdrawn" as const);
      for (const [index, part] of proposed.review.entries()) {
        if (!((yield* stillPreparing(id, proposed)) && (yield* permitted))) return yield* withdrawn;
        if (!("messageId" in (yield* create(part, `part ${index}`)))) return yield* failed;
      }
      if (!(yield* permitted)) return yield* withdrawn;
      const expiresAt = new Date((yield* Clock.currentTimeMillis) + CONSENT_MS).toISOString();
      const usable = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* stillPreparing(id, proposed))) return false;
          yield* sql`UPDATE chat_proposals SET state='presented',expires_at=${expiresAt} WHERE id=${id}`;
          return true;
        }),
      );
      if (!usable) return yield* withdrawn;
      const button = yield* create(confirmationText(expiresAt), "button", {
        customId: `${BUTTON_PREFIX}${id}`,
        label: proposed.confirmation.label,
      });
      if ("failure" in button && button.failure !== "unknown") return yield* failed;
      if ("messageId" in button) {
        yield* sql`UPDATE chat_proposals SET button_message_id=${button.messageId} WHERE id=${id}`;
        yield* buttons.changed;
      }
      return "presented";
    }).pipe(Effect.onInterrupt(() => fail(id)));

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
          // The click that decided it, if any, disables the button in place.
          yield* sql`UPDATE chat_proposals SET state='consumed',ended_reason=NULL,button_settled=1 WHERE id=${row.id}`;
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
      if (outcome.kind === "accepted" && outcome.originRunId !== undefined)
        originRecorded(outcome.originRunId);
      if (outcome.kind === "accepted" || outcome.kind === "rejected") yield* deliveries.wake;
    });

  /** Shared Start may wait on external preflight; taking a click is not Run acceptance. */
  const acceptance = (row: ProposalRow, click: ConfirmationClick): StartAuthorization => ({
    check: Effect.gen(function* () {
      if (!click.operating())
        return failure("conflict", "Chat control is Off. Nothing was started.");
      const access = yield* click.access;
      if (access === "unavailable")
        return failure("conflict", "Discord access could not be confirmed. Nothing was started.");
      if (access === "denied")
        return failure("validation", "Discord no longer permits this confirmation.");
      return { ok: true, value: undefined };
    }),
    commit: Effect.gen(function* () {
      const current = (yield* proposal(row.id))!;
      if (current.state !== "accepting")
        return failure("validation", "This confirmation is no longer valid.");
      if (yield* expired(current))
        return failure("validation", "This review expired before Factory accepted the Start.");
      const [state] = yield* sql<{
        enabled: number;
        application_id: string | null;
      }>`SELECT enabled,application_id FROM chat_control_state WHERE singleton=1`;
      if (!state!.enabled || !click.operating())
        return failure("conflict", "Chat control is Off. Nothing was started.");
      if (state!.application_id !== current.application_id)
        return failure(
          "validation",
          "The Discord application changed before Factory accepted the Start.",
        );
      if (!(yield* scopeGranted(current)))
        return failure("validation", "Access no longer permits this Start.");
      return { ok: true, value: undefined };
    }),
  });

  /** Performs a consumed proposal under its action identity, outside any transaction. */
  const perform = (row: ProposalRow, actionId: string, click: ConfirmationClick) =>
    Effect.gen(function* () {
      performing.add(actionId);
      const operation = byName.get(row.operation)!;
      const parameters = JSON.parse(row.parameters_json) as JSONValue;
      const executed = yield* Effect.result(
        operation.execute(actionId, parameters, acceptance(row, click)),
      );
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
    Effect.gen(function* (): Effect.fn.Return<ClickAnswer, unknown> {
      const action = yield* actionOf(row.id);
      if (!action) return ephemeral(REPLIES.invalid);
      // Reconciliation needs no clicker; any result is shown only to its requester, here, with
      // current access.
      const reconciled =
        action.state === "accepting" && !performing.has(action.id)
          ? yield* reconcileAction(row, action)
          : undefined;
      if ((yield* click.access) !== "permitted") return ephemeral(REPLIES.denied);
      if (action.state === "accepting")
        return reconciled === undefined
          ? ephemeral(REPLIES.confirming)
          : outcomeAnswer(row.id, reconciled.kind);
      const operation = byName.get(row.operation)!;
      return ephemeral(
        `You already confirmed this review. ${operation.summary({
          kind: action.state,
          facts: JSON.parse(action.outcome_json!) as JSONValue,
        })}`,
      );
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
        if (!(yield* scopeGranted(current))) return { refused: "denied" };
        const [operating] = yield* sql<{
          application_id: string | null;
        }>`SELECT application_id FROM chat_control_state WHERE singleton=1`;
        if (operating?.application_id !== current.application_id) return { refused: "invalid" };
        const actionId = yield* newId;
        const startedAt = yield* now;
        yield* sql`UPDATE chat_proposals SET state='accepting' WHERE id=${current.id} AND state='presented'`;
        yield* sql`INSERT INTO chat_actions (id,proposal_id,state,started_at) VALUES (${actionId},${current.id},'accepting',${startedAt})`;
        return { actionId };
      }),
    );

  /**
   * A confirmation button click and how to answer it. Wrong requester, wrong context, denied or
   * unavailable access never consume live consent and never change the button.
   */
  const confirm = (click: ConfirmationClick) =>
    Effect.gen(function* (): Effect.fn.Return<ClickAnswer, unknown> {
      const row = yield* proposal(click.customId.slice(BUTTON_PREFIX.length));
      const refused = clickRefusal(row, click);
      if (refused === "repeated") return yield* repeatedClick(row!, click);
      if (refused) return ephemeral(REPLIES[refused]);
      if (yield* expired(row!)) return ephemeral(REPLIES.expired);
      const access = yield* click.access;
      if (access !== "permitted") return ephemeral(REPLIES[access]);
      // Chat control turned Off meanwhile: nothing is consumed and the consent stays live.
      if (!click.operating()) return ephemeral(REPLIES.notNow);
      const taken = yield* take(row!);
      if (!("refused" in taken))
        return outcomeAnswer(row!.id, (yield* perform(row!, taken.actionId, click)).kind);
      return taken.refused === "confirming"
        ? yield* repeatedClick(row!, click)
        : ephemeral(REPLIES[taken.refused]);
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

  return {
    open,
    present,
    fail,
    confirm,
    recover,
    statuses,
    reconciling,
    /** The serving session's best-effort retirement of buttons that can no longer confirm. */
    serveButtons: buttons.serve,
    /** Something outside this module may have made reviews unusable, e.g. an Access save. */
    buttonsChanged: buttons.changed,
  };
}

export type ChatActions = ReturnType<typeof makeChatActions>;

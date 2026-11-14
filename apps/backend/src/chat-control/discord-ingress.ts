import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import type { DiscordCommandSetup } from "@t3-factory/contracts";
import { now } from "../time.ts";
import { grantedProjects } from "./access.ts";
import { isConfirmation, type ClickAnswer, type ConfirmationClick } from "./actions.ts";
import { buttonRow } from "./confirmation-buttons.ts";
import type { ConversationGenerations, ConversationKey } from "./conversations.ts";
import {
  BUSY_REPLY,
  type AdmittedInvocation,
  type Interpreter,
  type ReplyTarget,
  type Reservation,
} from "./interpretation.ts";
import type { EvidenceToken, RequesterEvidence } from "./requester-evidence.ts";

/** The message an event replied to, exactly as that event's payload carried it. */
export interface ReferencedMessage {
  /** Discord's reference type: 0 is a reply, 1 a forward. */
  readonly referenceType: number;
  /** Null when Discord could not supply the message, for example because it was deleted. */
  readonly message: {
    readonly id: string;
    readonly channel_id: string;
    readonly type: number;
    readonly content: string;
    readonly author: { readonly id: string; readonly bot?: boolean; readonly system?: boolean };
    readonly webhook_id?: string;
  } | null;
}

/** What admission needs from the operating session. */
interface IngressSession {
  readonly sql: SqlClient.SqlClient;
  readonly client: Client<true>;
  readonly applicationId: string;
  readonly evidence: RequesterEvidence;
  readonly generations: ConversationGenerations;
  /** Whether this session still admits work: Chat control is On and the session not released. */
  readonly operating: () => boolean;
  /** Creates the public thread for a parent-channel invocation; returns its ID. */
  readonly startThread: (channelId: string, messageId: string) => Promise<string>;
  /** Hands an admitted message to Chat SDK, which calls `admitted` with its thread. */
  readonly handOff: (threadId: string, message: Message) => Promise<void>;
  readonly encodeThreadId: (key: ConversationKey) => string;
  /** Publishes one Factory message in the conversation's thread, mentioning nobody. */
  readonly post: (key: ConversationKey, text: string) => Promise<unknown>;
  /** The reply target the current MESSAGE_CREATE payload carried, taken once. */
  readonly referenced: (messageId: string) => ReferencedMessage | undefined;
  /** Decides a confirmation button click and how to answer it. */
  readonly confirm: (click: ConfirmationClick) => Effect.Effect<ClickAnswer, unknown>;
  /**
   * The Run a message this application published in `threadId` identifies, if Factory recorded
   * one for it. Only the identity is returned: the message's content is never imported.
   */
  readonly publishedRun: (
    threadId: string,
    messageId: string,
  ) => Effect.Effect<string | undefined, unknown>;
}

const RESET_REPLIES = {
  cleared:
    "Factory cleared this thread's Chat control conversation. Later requests here start fresh; Discord messages and work Factory already accepted are unchanged.",
  "not-thread": "Use /factory reset inside a Chat control thread.",
  denied: "Chat control does not accept this command from you here.",
  unavailable:
    "Factory could not confirm your access to this thread, so nothing was cleared. Try again.",
} as const;

/**
 * The only command Factory registers. Discord creates or updates it by name and leaves the
 * application's other commands untouched, since the application may also serve other software.
 */
const FACTORY_COMMAND = {
  name: "factory",
  description: "Factory Chat control",
  type: ApplicationCommandType.ChatInput,
  contexts: [InteractionContextType.Guild],
  integration_types: [ApplicationIntegrationType.GuildInstall],
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "reset",
      description: "Clear this thread's shared Chat control conversation",
    },
  ],
};

/** Registers `/factory reset` for the verified application through Discord's REST API. */
export const registerCommands = (client: Client<true>, applicationId: string) =>
  Effect.gen(function* () {
    const registered = yield* Effect.result(
      Effect.tryPromise(() =>
        client.rest.post(Routes.applicationCommands(applicationId), { body: FACTORY_COMMAND }),
      ),
    );
    const occurredAt = yield* now;
    if (registered._tag === "Success")
      return {
        outcome: "registered",
        message: "Discord accepted /factory reset for this application.",
        occurredAt,
      } satisfies DiscordCommandSetup;
    const error = registered.failure.cause;
    return {
      outcome: "failed",
      message:
        error instanceof DiscordAPIError
          ? `Discord answered HTTP ${error.status} when Factory registered /factory reset.`
          : "Factory could not reach Discord to register /factory reset.",
      occurredAt,
    } satisfies DiscordCommandSetup;
  });

type Access = "permitted" | "denied" | "unavailable";

/**
 * Where an explicit invocation was made: a new human message of an ordinary type that mentions
 * or replies to the bot in a text or announcement channel or a thread. Anything else is ignored.
 */
function explicitInvocation(message: Message<true>, botUserId: string) {
  if (message.author.bot || message.webhookId !== null || message.system) return undefined;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return undefined;
  const invoked =
    message.mentions.users.has(botUserId) || message.mentions.repliedUser?.id === botUserId;
  if (!invoked) return undefined;
  const channel = message.channel;
  if (channel.isThread())
    return channel.parentId ? { thread: channel, parentId: channel.parentId } : undefined;
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement
    ? { thread: null, parentId: channel.id }
    : undefined;
}

/** Discord affirmatively answered that the user is not a member; anything else is unresolved. */
const unknownMember = (error: unknown) =>
  error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember;

// Discord redelivers events only within a resumed session, far sooner than this; it matches the
// longest a conversation generation lasts.
const MARKER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Factory's policy gate for one operating session. Every Discord message and interaction passes
 * here before anything else happens: a thread is created, a conversation opened, Chat SDK
 * involved or anything published only for an explicit invocation by an allowed human user in an
 * allowed parent channel (or its thread) that grants at least one Factory Project, with current
 * evidence of the requester's access.
 */
export function makeIngress(session: IngressSession, interpreter: Interpreter) {
  const { sql, client, applicationId, evidence, generations } = session;
  const botUserId = client.user.id;
  /** Admitted messages on their way through Chat SDK to Factory's handler. */
  const pending = new Map<
    string,
    { readonly invocation: AdmittedInvocation; readonly reservation: Reservation | "busy" }
  >();

  /** Records a Discord event once; false when Factory already took this delivery. */
  const firstDelivery = (eventId: string) =>
    Effect.gen(function* () {
      const receivedAt = yield* now;
      const expired = new Date(Date.parse(receivedAt) - MARKER_RETENTION_MS).toISOString();
      yield* sql`DELETE FROM chat_ingress_events WHERE received_at<${expired}`;
      const rows = yield* sql`INSERT INTO chat_ingress_events (application_id,event_id,received_at)
        VALUES (${applicationId},${eventId},${receivedAt}) ON CONFLICT DO NOTHING RETURNING event_id`;
      return rows.length > 0;
    });

  const permittedProjects = (userId: string, parentChannelId: string) =>
    Effect.map(grantedProjects(sql, userId, parentChannelId), (projects) => projects.length > 0);

  /** Whether a private thread's member list includes the user, asked of Discord directly. */
  const privateThreadMember = (thread: ThreadChannel, userId: string) =>
    Effect.gen(function* (): Effect.fn.Return<Access, unknown> {
      const member = yield* Effect.result(
        Effect.tryPromise(() =>
          thread.members.fetch({ member: userId, force: true, cache: false }),
        ),
      );
      if (member._tag === "Success") return "permitted";
      return unknownMember(member.failure.cause) ? "denied" : "unavailable";
    });

  /**
   * A targeted refresh of the requester's access to the conversation's thread, for work whose
   * evidence a connection gap or change made stale: the member's current permissions on the
   * thread and, for a private thread, its membership.
   */
  const refreshedAccess = (conversation: ConversationKey, userId: string) =>
    Effect.gen(function* (): Effect.fn.Return<Access, unknown> {
      const guild = client.guilds.cache.get(conversation.guildId);
      const channel = yield* Effect.result(
        Effect.tryPromise(() => client.channels.fetch(conversation.threadId)),
      );
      if (!guild || channel._tag === "Failure" || !channel.success?.isThread())
        return "unavailable";
      const thread = channel.success;
      const member = yield* Effect.result(
        Effect.tryPromise(() => guild.members.fetch({ user: userId, force: true, cache: false })),
      );
      if (member._tag === "Failure")
        return unknownMember(member.failure.cause) ? "denied" : "unavailable";
      if (!thread.permissionsFor(member.success)?.has(PermissionFlagsBits.ViewChannel))
        return "denied";
      return thread.type === ChannelType.PrivateThread
        ? yield* privateThreadMember(thread, userId)
        : "permitted";
    });

  /**
   * Whether admitted work may still dispatch or publish: On, current policy and generation, and
   * current evidence of the requester's access. Private-thread membership is refreshed on every
   * check: without Server Members intent, other-user removal events are not reliable evidence.
   */
  const permitted = (
    conversation: ConversationKey,
    requesterId: string,
    generation: number,
    initial: EvidenceToken,
    privateThread: boolean,
  ) => {
    let token = initial;
    return Effect.gen(function* () {
      if (!session.operating()) return false;
      if (!(yield* permittedProjects(requesterId, conversation.parentChannelId))) return false;
      if (!(yield* generations.isCurrent(conversation, generation))) return false;
      if (evidence.isCurrent(token) && !privateThread) return true;
      const refreshed = evidence.token(conversation.guildId);
      if ((yield* refreshedAccess(conversation, requesterId)) !== "permitted") return false;
      if (!evidence.isCurrent(refreshed)) return false;
      token = refreshed;
      return (
        session.operating() &&
        (yield* permittedProjects(requesterId, conversation.parentChannelId)) &&
        (yield* generations.isCurrent(conversation, generation))
      );
    });
  };

  /**
   * The human message the invoker selected by replying to it, as the event supplied it, or the
   * Run a replied-to Factory message identifies.
   */
  const replyTarget = (message: Message<true>, threadId: string) =>
    Effect.gen(function* (): Effect.fn.Return<ReplyTarget, unknown> {
      const reference = session.referenced(message.id);
      if (message.type !== MessageType.Reply || !reference || reference.referenceType !== 0)
        return { kind: "none" };
      const target = reference.message;
      if (!target) return { kind: "unusable" };
      // Replying to the bot is how it was invoked; bot prose is never imported as a quote. A
      // Factory message of this thread may identify a Run, which is then read afresh.
      if (target.author.id === botUserId) {
        const ordinary =
          target.channel_id === threadId &&
          target.webhook_id === undefined &&
          (target.type === MessageType.Default || target.type === MessageType.Reply);
        const runId = ordinary ? yield* session.publishedRun(threadId, target.id) : undefined;
        return runId === undefined ? { kind: "none" } : { kind: "run", runId };
      }
      return selectedReply(target, threadId);
    });

  const selectedReply = (
    target: NonNullable<ReferencedMessage["message"]>,
    threadId: string,
  ): ReplyTarget => {
    if (
      target.channel_id !== threadId ||
      target.author.bot === true ||
      target.author.system === true ||
      target.webhook_id !== undefined ||
      (target.type !== MessageType.Default && target.type !== MessageType.Reply)
    )
      return { kind: "unusable" };
    return { kind: "selected", reply: { authorId: target.author.id, text: target.content } };
  };

  /**
   * Authorizes and records an invocation, creating its thread, and queues it in its conversation;
   * the conversation, or nothing when it was not admitted.
   */
  const admitMessage = (message: Message<true>, thread: ThreadChannel | null, parentId: string) =>
    Effect.gen(function* () {
      if (!(yield* permittedProjects(message.author.id, parentId))) return undefined;
      if (!(yield* firstDelivery(message.id))) return undefined;
      const token = evidence.token(message.guildId);
      const threadId =
        thread?.id ??
        (yield* Effect.option(
          Effect.tryPromise(() => session.startThread(message.channelId, message.id)),
        ).pipe(Effect.map((created) => (created._tag === "Some" ? created.value : undefined))));
      if (threadId === undefined) return undefined;
      const conversation = {
        applicationId,
        guildId: message.guildId,
        parentChannelId: parentId,
        threadId,
      };
      const generation = yield* generations.open(conversation);
      const invocation: AdmittedInvocation = {
        conversation,
        generation,
        requesterId: message.author.id,
        messageId: message.id,
        text: message.content,
        replyTarget: yield* replyTarget(message, threadId),
        admittedAt: yield* Clock.currentTimeMillis,
        permitted: permitted(
          conversation,
          message.author.id,
          generation,
          token,
          thread?.type === ChannelType.PrivateThread,
        ),
      };
      pending.set(message.id, { invocation, reservation: yield* interpreter.reserve(invocation) });
      return invocation;
    });

  /** Whether the requester may act in `thread` now, from the interaction and maintained evidence. */
  const requesterAccess = (
    interaction:
      | ChatInputCommandInteraction<"cached" | "raw">
      | ButtonInteraction<"cached" | "raw">,
    thread: ThreadChannel,
  ) =>
    Effect.gen(function* (): Effect.fn.Return<Access, unknown> {
      const userId = interaction.user.id;
      if (!thread.parentId || !(yield* permittedProjects(userId, thread.parentId))) return "denied";
      // Discord computes these for the channel the command was used in, including overwrites.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) return "denied";
      if (thread.type !== ChannelType.PrivateThread) return "permitted";
      const token = evidence.token(interaction.guildId);
      const membership = yield* privateThreadMember(thread, userId);
      if (membership !== "permitted") return membership;
      return evidence.isCurrent(token) &&
        session.operating() &&
        (yield* permittedProjects(userId, thread.parentId))
        ? "permitted"
        : "denied";
    });

  /**
   * Acknowledges an interaction privately at once, since the acknowledgement is due within three
   * seconds and access checks may need Discord itself; its channel and thread, or nothing when
   * Discord refused the acknowledgement.
   */
  const acknowledged = (
    interaction:
      | ChatInputCommandInteraction<"cached" | "raw">
      | ButtonInteraction<"cached" | "raw">,
  ) =>
    Effect.map(
      Effect.option(
        Effect.tryPromise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })),
      ),
      (deferred) => {
        if (deferred._tag === "None") return undefined;
        const channel = interaction.channel;
        return { channel, thread: channel?.isThread() ? channel : null };
      },
    );

  const reset = (interaction: ChatInputCommandInteraction<"cached" | "raw">) =>
    Effect.gen(function* () {
      if (!(yield* firstDelivery(interaction.id))) return;
      const place = yield* acknowledged(interaction);
      if (!place) return;
      const { channel, thread } = place;
      let reply: keyof typeof RESET_REPLIES = channel ? "not-thread" : "unavailable";
      if (thread) {
        const access = yield* requesterAccess(interaction, thread);
        reply = access === "permitted" ? "cleared" : access;
        if (access === "permitted" && session.operating())
          yield* generations.clear({
            applicationId,
            guildId: interaction.guildId,
            parentChannelId: thread.parentId!,
            threadId: thread.id,
          });
      }
      yield* Effect.ignore(Effect.tryPromise(() => interaction.editReply(RESET_REPLIES[reply])));
    });

  /**
   * A confirmation button click: acknowledged at once as a deferred update of its message, then
   * decided outside the gate, since performing an action may take longer than later events
   * should wait. A click that decided the review disables the button for everyone; any other
   * answer goes privately to the clicker and leaves the button as it is.
   */
  const confirmation = (interaction: ButtonInteraction<"cached" | "raw">) =>
    Effect.gen(function* () {
      if (!(yield* gate.withPermits(1)(firstDelivery(interaction.id)))) return;
      const deferred = yield* Effect.option(Effect.tryPromise(() => interaction.deferUpdate()));
      if (deferred._tag === "None") return;
      const channel = interaction.channel;
      const thread = channel?.isThread() ? channel : null;
      const answer = yield* session.confirm({
        customId: interaction.customId,
        userId: interaction.user.id,
        threadId: interaction.channelId,
        applicationId,
        operating: session.operating,
        access: thread ? requesterAccess(interaction, thread) : Effect.succeed("unavailable"),
      });
      if (answer.kind === "ephemeral")
        return yield* Effect.ignore(
          Effect.tryPromise(() =>
            interaction.followUp({
              content: answer.text,
              flags: MessageFlags.Ephemeral,
              allowedMentions: { parse: [] },
            }),
          ),
        );
      // Editing the message is an external send, which never happens while Chat control is Off.
      if (session.operating())
        yield* Effect.ignore(
          Effect.tryPromise(() =>
            interaction.editReply({
              components: buttonRow(answer.customId, { disabled: answer.state }),
              allowedMentions: { parse: [] },
            }),
          ),
        );
    });

  // Events pass the gate one at a time in delivery order, so a repeated delivery meets the
  // marker its first delivery left and later events see every earlier decision.
  // Queue places are taken here too, so each conversation's queue follows admission order.
  const gate = Semaphore.makeUnsafe(1);

  return {
    /** A Discord message; only explicit authorized invocations go further. */
    message: (message: Message) =>
      Effect.gen(function* () {
        if (!session.operating() || !message.inGuild()) return;
        const place = explicitInvocation(message, botUserId);
        if (!place) return;
        const { thread, parentId } = place;
        const invocation = yield* gate.withPermits(1)(admitMessage(message, thread, parentId));
        if (!invocation) return;
        yield* Effect.promise(() =>
          session.handOff(session.encodeThreadId(invocation.conversation), message),
        );
        const handled = pending.get(message.id);
        pending.delete(message.id);
        // Chat SDK did not hand the message to Factory's handler; its queue place is released.
        if (handled && handled.reservation !== "busy") yield* handled.reservation.cancel;
      }),
    /**
     * A Discord interaction; only `/factory reset` and confirmation buttons of this application
     * are handled.
     */
    interaction: (interaction: Interaction) =>
      Effect.gen(function* () {
        if (!session.operating() || !interaction.inGuild()) return;
        if (interaction.applicationId !== applicationId) return;
        if (interaction.isButton() && isConfirmation(interaction.customId))
          return yield* confirmation(interaction);
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "factory") return;
        if (interaction.options.getSubcommand(false) !== "reset") return;
        yield* gate.withPermits(1)(reset(interaction));
      }),
    /** Chat SDK's mention handler for an admitted message. */
    admitted: (messageId: string) =>
      Effect.gen(function* () {
        const handled = pending.get(messageId);
        if (!handled) return;
        pending.delete(messageId);
        const { invocation, reservation } = handled;
        if (reservation !== "busy") return yield* reservation.attach;
        // Overflow feedback is deterministic and the message is not queued or retained.
        if (yield* invocation.permitted)
          yield* Effect.ignore(
            Effect.tryPromise(() => session.post(invocation.conversation, BUSY_REPLY)),
          );
      }),
  };
}

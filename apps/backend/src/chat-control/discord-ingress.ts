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
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type { Thread } from "chat";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import type { DiscordCommandSetup } from "@t3-factory/contracts";
import { now } from "../time.ts";
import { grantedProjects } from "./access.ts";
import type { ConversationGenerations, ConversationKey } from "./conversations.ts";
import type { EvidenceToken, RequesterEvidence } from "./requester-evidence.ts";

/**
 * An explicit invocation Factory authorized and admitted into a conversation. Requester and scope
 * come from the Discord event and Factory's policy, never from the message text. Work on it must
 * recheck `stillPermitted` before anything is published or recorded.
 */
export interface AdmittedInvocation {
  readonly conversation: ConversationKey;
  readonly generation: number;
  readonly requesterId: string;
  readonly messageId: string;
  /** The message text as admitted; later Discord edits never change it. */
  readonly text: string;
  readonly evidence: EvidenceToken;
  /** The Chat SDK thread replies go to. */
  readonly thread: Thread;
  /** Whether the invocation may still publish: On, current evidence, policy and generation. */
  readonly stillPermitted: Effect.Effect<boolean, unknown>;
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
}

// Interpretation is a later slice; until then an admitted invocation gets this fixed reply.
const ACKNOWLEDGEMENT =
  "Factory received this request. Chat control cannot answer conversational requests yet.";

const RESET_REPLIES = {
  cleared:
    "Factory cleared this thread's Chat control conversation. Later requests here start fresh; Discord messages and work Factory already accepted are unchanged.",
  "not-thread": "Use /factory reset inside a Chat control thread.",
  denied: "Chat control does not accept this command from you here.",
  unavailable:
    "Factory could not confirm your access to this thread, so nothing was cleared. Try again.",
} as const;

/** The only command Factory registers. Registration replaces every other command of the application. */
const FACTORY_COMMANDS = [
  {
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
  },
];

/** Registers `/factory reset` for the verified application through Discord's REST API. */
export const registerCommands = (client: Client<true>, applicationId: string) =>
  Effect.gen(function* () {
    const registered = yield* Effect.result(
      Effect.tryPromise(() =>
        client.rest.put(Routes.applicationCommands(applicationId), { body: FACTORY_COMMANDS }),
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
 * Factory's policy gate for one operating session. Every Discord message and interaction passes
 * here before anything else happens: a thread is created, a conversation opened, Chat SDK
 * involved or anything published only for an explicit invocation by an allowed human user in an
 * allowed parent channel (or its thread) that grants at least one Factory Project, with current
 * evidence of the requester's access.
 */
export function makeIngress(
  session: IngressSession,
  admit: (invocation: AdmittedInvocation) => Effect.Effect<void>,
) {
  const { sql, client, applicationId, evidence, generations } = session;
  const botUserId = client.user.id;
  type Pending = Omit<AdmittedInvocation, "thread" | "stillPermitted">;
  const pending = new Map<string, Pending>();

  /** Records a Discord event once; false when Factory already took this delivery. */
  const firstDelivery = (eventId: string) =>
    Effect.gen(function* () {
      const receivedAt = yield* now;
      const rows = yield* sql`INSERT INTO chat_ingress_events (application_id,event_id,received_at)
        VALUES (${applicationId},${eventId},${receivedAt}) ON CONFLICT DO NOTHING RETURNING event_id`;
      return rows.length > 0;
    });

  const permittedProjects = (userId: string, parentChannelId: string) =>
    Effect.map(grantedProjects(sql, userId, parentChannelId), (projects) => projects.length > 0);

  /** Whether admitted work may still publish: On, unchanged evidence, policy and generation. */
  const stillPermitted = (invocation: Pending) =>
    Effect.gen(function* () {
      if (!session.operating() || !evidence.isCurrent(invocation.evidence)) return false;
      if (
        !(yield* permittedProjects(invocation.requesterId, invocation.conversation.parentChannelId))
      )
        return false;
      return yield* generations.isCurrent(invocation.conversation, invocation.generation);
    });

  /** Authorizes and records an invocation, creating its thread; the conversation it joined. */
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
      pending.set(message.id, {
        conversation,
        generation: yield* generations.open(conversation),
        requesterId: message.author.id,
        messageId: message.id,
        text: message.content,
        evidence: token,
      });
      return conversation;
    });

  /** Whether the requester may act in `thread` now, from the interaction and maintained evidence. */
  const requesterAccess = (
    interaction: ChatInputCommandInteraction<"cached" | "raw">,
    thread: ThreadChannel,
  ) =>
    Effect.gen(function* (): Effect.fn.Return<Access, unknown> {
      const userId = interaction.user.id;
      if (!thread.parentId || !(yield* permittedProjects(userId, thread.parentId))) return "denied";
      // Discord computes these for the channel the command was used in, including overwrites.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) return "denied";
      if (thread.type !== ChannelType.PrivateThread || evidence.isMember(thread.id, userId))
        return "permitted";
      const token = evidence.token(interaction.guildId);
      const member = yield* Effect.result(
        Effect.tryPromise(() =>
          thread.members.fetch({ member: userId, force: true, cache: false }),
        ),
      );
      if (member._tag === "Success") {
        if (evidence.isCurrent(token)) evidence.joined(interaction.guildId, thread.id, userId);
        return "permitted";
      }
      const error = member.failure.cause;
      return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember
        ? "denied"
        : "unavailable";
    });

  const reset = (interaction: ChatInputCommandInteraction<"cached" | "raw">) =>
    Effect.gen(function* () {
      if (!(yield* firstDelivery(interaction.id))) return;
      // The acknowledgement is due within three seconds; access checks may need Discord itself.
      const deferred = yield* Effect.option(
        Effect.tryPromise(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })),
      );
      if (deferred._tag === "None") return;
      const channel = interaction.channel;
      const thread = channel?.isThread() ? channel : null;
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

  // Events pass the gate one at a time in delivery order, so a repeated delivery meets the
  // marker its first delivery left and later events see every earlier decision.
  const gate = Semaphore.makeUnsafe(1);
  const conversationLanes = new Map<string, Semaphore.Semaphore>();
  /** One admitted invocation at a time per conversation, in admission order. */
  const serialized = (threadId: string, work: Effect.Effect<void>) => {
    let lane = conversationLanes.get(threadId);
    if (!lane) conversationLanes.set(threadId, (lane = Semaphore.makeUnsafe(1)));
    return lane.withPermits(1)(work);
  };

  return {
    /** A Discord message; only explicit authorized invocations go further. */
    message: (message: Message) =>
      Effect.gen(function* () {
        if (!session.operating() || !message.inGuild()) return;
        if (message.author.bot || message.webhookId !== null || message.system) return;
        if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
        const invoked =
          message.mentions.users.has(botUserId) || message.mentions.repliedUser?.id === botUserId;
        if (!invoked) return;
        const channel = message.channel;
        const thread = channel.isThread() ? channel : null;
        if (
          !thread &&
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        )
          return;
        const parentId = thread ? thread.parentId : channel.id;
        if (!parentId) return;
        // Discord let the author post here, which shows they can see this private thread.
        if (thread?.type === ChannelType.PrivateThread)
          evidence.joined(message.guildId, thread.id, message.author.id);
        const conversation = yield* gate.withPermits(1)(admitMessage(message, thread, parentId));
        if (!conversation) return;
        yield* Effect.promise(() =>
          session.handOff(session.encodeThreadId(conversation), message),
        ).pipe(Effect.ensuring(Effect.sync(() => pending.delete(message.id))));
      }),
    /** A Discord interaction; only `/factory reset` of this application is handled. */
    interaction: (interaction: Interaction) =>
      Effect.gen(function* () {
        if (!session.operating() || !interaction.inGuild()) return;
        if (!interaction.isChatInputCommand() || interaction.applicationId !== applicationId)
          return;
        if (interaction.commandName !== "factory") return;
        if (interaction.options.getSubcommand(false) !== "reset") return;
        yield* gate.withPermits(1)(reset(interaction));
      }),
    /** Chat SDK's mention handler: the admitted message with its thread. */
    admitted: (thread: Thread, messageId: string) =>
      Effect.gen(function* () {
        const invocation = pending.get(messageId);
        if (!invocation) return;
        yield* serialized(
          invocation.conversation.threadId,
          admit({ ...invocation, thread, stillPermitted: stillPermitted(invocation) }),
        );
      }),
  };
}

/**
 * The admission seam's current consumer: one fixed acknowledgement per admitted invocation,
 * published only while the invocation is still permitted.
 */
export const acknowledge = (invocation: AdmittedInvocation) =>
  Effect.gen(function* () {
    if (!(yield* invocation.stillPermitted)) return;
    yield* Effect.tryPromise(() => invocation.thread.post(ACKNOWLEDGEMENT));
  }).pipe(Effect.ignore);

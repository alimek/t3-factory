import { DiscordAdapter } from "@chat-adapter/discord";
import { Message as ChatMessage, type Thread } from "chat";
import { Events, type Client, type Interaction, type Message } from "discord.js";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  DiscordCommandSetup,
  DiscordConnectionProblem,
  DiscordConnectionStatus,
  Result,
} from "@t3-factory/contracts";
import { failure } from "../result.ts";
import { now } from "../time.ts";
import { sqliteChatState } from "./chat-state.ts";
import { accessIds, recordNames } from "./access.ts";
import { sendAccessTest } from "./access-test.ts";
import { clearConversations, conversationGenerations } from "./conversations.ts";
import type { ChatCredentials } from "./credentials.ts";
import {
  closeResult,
  lookupNames,
  type DiscordConnection,
  type DiscordGateway,
  type GatewayResult,
  type OperatingSession,
} from "./discord-gateway.ts";
import type { ChatActions } from "./actions.ts";
import type { ChatTool } from "./chat-tools.ts";
import { buttonRow, type DisabledButton } from "./confirmation-buttons.ts";
import {
  publishedRun,
  type ChatDeliveries,
  type CreateMessageOptions,
  type DiscordSender,
} from "./deliveries.ts";
import { makeIngress, registerCommands, type ReferencedMessage } from "./discord-ingress.ts";
import { makeInterpreter, type InterpretationEngine } from "./interpretation.ts";
import type { ConversationalModelAccess } from "./model.ts";
import { makeRequesterEvidence } from "./requester-evidence.ts";
import { retireApplicationProposals } from "./revocation.ts";

type Run = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;

/** The ingress handlers of one operating session. */
interface SessionIngress {
  readonly message: (message: Message) => Promise<void>;
  readonly interaction: (interaction: Interaction) => Promise<void>;
}

/**
 * The pinned Discord adapter with Factory's policy gate in front of its Gateway handlers. The
 * adapter's own message handler would create a thread for any mention before authorization, so
 * messages and interactions go to Factory's ingress instead, and reactions are ignored.
 */
class FactoryDiscordAdapter extends DiscordAdapter {
  ingress: SessionIngress | undefined;

  protected override async handleGatewayMessage(message: Message) {
    await this.ingress?.message(message);
  }

  protected override async handleGatewayInteraction(interaction: Interaction) {
    await this.ingress?.interaction(interaction);
  }

  protected override async handleGatewayReaction() {}

  protected override buildMessagePayload(
    ...args: Parameters<DiscordAdapter["buildMessagePayload"]>
  ) {
    const [message] = args;
    const built = super.buildMessagePayload(...args);
    const raw = typeof message === "object" && "raw" in message ? message.raw : undefined;
    if (raw !== undefined && raw.length > 2000)
      throw new Error("A Factory message exceeded Discord's length.");
    return {
      ...built,
      payload: {
        ...built.payload,
        ...(raw === undefined ? {} : { content: raw }),
        allowed_mentions: { parse: [] },
      },
    };
  }

  /** Factory splits its own messages; anything longer is a defect, never silently cut. */
  protected override truncateContent(content: string): string {
    if (content.length > 2000) throw new Error("A Factory message exceeded Discord's length.");
    return content;
  }

  /** Posts Factory's own text exactly as given, without Markdown conversion. */
  post(threadId: string, text: string) {
    return this.postMessage(threadId, { raw: text });
  }

  /**
   * Creates one Factory message, optionally with a confirmation button, in a single request and
   * resolves with Discord's message ID. Discord enforces `nonce`: a create repeating an earlier
   * one's nonce returns that message instead of creating another. Failures keep the adapter's
   * error, whose status tells a definite refusal from an unproven outcome.
   */
  async create(
    threadId: string,
    text: string,
    { nonce, button, requesterId }: CreateMessageOptions,
  ) {
    const raw = requesterId === undefined ? text : text.replace(" ", ` <@${requesterId}> `);
    const { payload } = this.buildMessagePayload({ raw });
    const { channelId, threadId: discordThreadId } = this.decodeThreadId(threadId);
    const response = await this.discordFetch(
      `/channels/${discordThreadId ?? channelId}/messages`,
      "POST",
      {
        ...payload,
        ...(requesterId === undefined
          ? {}
          : { allowed_mentions: { parse: [], users: [requesterId] } }),
        nonce,
        enforce_nonce: true,
        ...(button ? { components: buttonRow(button.customId, { label: button.label }) } : {}),
      },
    );
    return ((await response.json()) as { id: string }).id;
  }

  /** Replaces a Factory message's text, mentioning nobody, in a single request. */
  async edit(threadId: string, messageId: string, text: string) {
    const { payload } = this.buildMessagePayload({ raw: text });
    const { channelId, threadId: discordThreadId } = this.decodeThreadId(threadId);
    await this.discordFetch(
      `/channels/${discordThreadId ?? channelId}/messages/${messageId}`,
      "PATCH",
      { content: payload.content, allowed_mentions: payload.allowed_mentions },
    );
  }

  /** Replaces a review's button with a disabled one showing why, in a single request. */
  async disable(threadId: string, messageId: string, customId: string, state: DisabledButton) {
    const { channelId, threadId: discordThreadId } = this.decodeThreadId(threadId);
    await this.discordFetch(
      `/channels/${discordThreadId ?? channelId}/messages/${messageId}`,
      "PATCH",
      { components: buttonRow(customId, { disabled: state }), allowed_mentions: { parse: [] } },
    );
  }

  /**
   * Unarchives the thread if a fresh read shows it archived and not locked. A locked thread is
   * left as it is: only its moderators may unlock it.
   */
  async reopen(threadId: string): Promise<"open" | "reopened" | "locked"> {
    const { path, metadata } = await this.threadMetadata(threadId);
    if (!metadata?.archived) return "open";
    if (metadata.locked) return "locked";
    await this.discordFetch(path, "PATCH", { archived: false });
    return "reopened";
  }

  /** Whether a fresh read shows the thread locked by its moderators. */
  async locked(threadId: string): Promise<boolean> {
    return (await this.threadMetadata(threadId)).metadata?.locked === true;
  }

  private async threadMetadata(threadId: string) {
    const { channelId, threadId: discordThreadId } = this.decodeThreadId(threadId);
    const path = `/channels/${discordThreadId ?? channelId}`;
    const channel = (await (await this.discordFetch(path, "GET")).json()) as {
      thread_metadata?: { archived?: boolean; locked?: boolean };
    };
    return { path, metadata: channel.thread_metadata };
  }

  /** Triggers Discord's typing indicator in the thread, in a single request. */
  async typing(threadId: string) {
    const { channelId, threadId: discordThreadId } = this.decodeThreadId(threadId);
    await this.discordFetch(`/channels/${discordThreadId ?? channelId}/typing`, "POST");
  }

  listen(client: Client, isShuttingDown: () => boolean) {
    this.setupLegacyGatewayHandlers(client, isShuttingDown);
  }

  async startThread(channelId: string, messageId: string) {
    return (await this.createDiscordThread(channelId, messageId)).id;
  }

  /** Gives an admitted message to Chat SDK, which deduplicates it and calls the mention handler. */
  handOff(threadId: string, message: Message) {
    return this.chat!.processMessage(
      this,
      threadId,
      new ChatMessage({
        id: message.id,
        threadId,
        text: message.content,
        formatted: this.formatConverter.parseIncoming(message.content).formatted,
        author: {
          userId: message.author.id,
          userName: message.author.username,
          fullName: message.author.displayName,
          isBot: false,
          isMe: false,
        },
        metadata: { dateSent: message.createdAt, edited: false },
        attachments: [],
        raw: { id: message.id, channel_id: message.channelId, guild_id: message.guildId },
        isMention: true,
      }),
    );
  }
}

/** The parts of Discord's THREAD_MEMBERS_UPDATE dispatch that bear on requester evidence. */
interface ThreadMembersUpdate {
  readonly id: string;
  readonly guild_id: string;
  readonly added_members?: readonly { readonly user_id: string }[];
  readonly removed_member_ids?: readonly string[];
}

/** The parts of Discord's MESSAGE_CREATE dispatch that carry a reply target. */
interface RawMessageCreate {
  readonly id: string;
  readonly message_reference?: { readonly type?: number };
  readonly referenced_message?: ReferencedMessage["message"];
}

/** References of messages that never reached admission are dropped beyond this many. */
const MAX_HELD_REFERENCES = 256;

type StateRow = {
  enabled: number;
  rejected_outcome: DiscordConnectionProblem["outcome"] | null;
  rejected_message: string | null;
  rejected_at: string | null;
};

/** The operating connection as Settings shows it. */
export interface OperationStatus {
  readonly connectionStatus: Extract<
    DiscordConnectionStatus,
    "connecting" | "connected" | "reconnecting" | "rejected"
  >;
  readonly connectionProblem: DiscordConnectionProblem | null;
  readonly commandSetup: DiscordCommandSetup | null;
}

const MAX_BACKOFF_MS = 300_000;
/** Waits between transient failures: 1 s doubling to five minutes, within Node's timer range. */
const backoff = (failures: number) =>
  Duration.millis(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS));

const UNEXPECTED_STOP =
  "Chat control's Discord connection stopped unexpectedly. Retry to reconnect.";

const RECONNECTING: Omit<DiscordConnectionProblem, "occurredAt"> = {
  outcome: "unreachable",
  message: "Discord closed the Gateway connection. Factory is reconnecting.",
};

/**
 * Records the application an operating session authenticated as. Another application than the
 * recorded one is an application replacement: it inherits no conversation history or consent, and
 * switching back later revives none. Owed messages stay owed; the deliveries of the serving
 * application retire the old application's edits and replace its cards.
 */
const adoptApplication = (sql: SqlClient.SqlClient, applicationId: string, botName: string) =>
  sql.withTransaction(
    Effect.gen(function* (): Effect.fn.Return<readonly string[], unknown> {
      const [state] = yield* sql<{
        application_id: string | null;
      }>`SELECT application_id FROM chat_control_state WHERE singleton=1`;
      const recorded = state!.application_id;
      yield* sql`UPDATE chat_control_state SET application_id=${applicationId},bot_name=${botName} WHERE singleton=1`;
      if (recorded === applicationId || recorded === null) return [];
      yield* clearConversations(sql, "all");
      return yield* retireApplicationProposals(sql, recorded);
    }),
  );

/**
 * Chat control's operating Discord connection. While On, one supervisor fiber in the backend's
 * scope runs one Gateway session at a time through the gateway's single listener, records the
 * application Discord authenticated before attaching any handler or registering the command, backs off
 * after transient failures and stops after failures that need correction, recording them so a
 * restart does not reconnect until the owner retries.
 */
export const makeDiscordOperation = (
  gateway: DiscordGateway,
  credentials: ChatCredentials,
  conversation: {
    readonly model: ConversationalModelAccess;
    readonly tools: readonly ChatTool[];
    readonly actions: ChatActions;
    readonly deliveries: ChatDeliveries;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    /** The serving session's interpretation, while one serves. */
    let interpreter: InterpretationEngine | undefined;
    /** The serving session's Discord client, while one serves. */
    let serving: { client: Client<true>; released: () => boolean } | undefined;
    const testing = Semaphore.makeUnsafe(1);
    const supervisor = yield* FiberHandle.make<void>();
    const generations = conversationGenerations(sql);
    let current: Omit<OperationStatus, "connectionStatus"> & {
      connectionStatus: Exclude<OperationStatus["connectionStatus"], "rejected">;
    } = { connectionStatus: "connecting", connectionProblem: null, commandSetup: null };

    const readState = Effect.map(
      sql<StateRow>`SELECT enabled,rejected_outcome,rejected_message,rejected_at FROM chat_control_state WHERE singleton=1`,
      ([row]) => row!,
    );

    /** The complete saved connection with its token, or why it cannot be used. */
    const savedConnection = credentials.read(
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordConnection>, unknown> {
        const [row] = yield* sql<{
          public_key: string | null;
          token_stage: string | null;
        }>`SELECT public_key,token_stage FROM chat_discord_connection WHERE singleton=1`;
        const token = row!.token_stage
          ? yield* credentials.secret(row!.token_stage, "discord-token")
          : null;
        if (!row!.public_key || token === null)
          return failure(
            "conflict",
            "The saved bot token is missing from the host's protected credentials. Replace it, then retry.",
          );
        return { ok: true, value: { publicKey: row!.public_key, token } };
      }),
    );

    /** Serves one authenticated session until Discord ends it for good. */
    const serve = ({
      applicationId,
      adapter,
      chat,
      client,
      released,
    }: OperatingSession<FactoryDiscordAdapter>) =>
      Effect.gen(function* () {
        const runPromise = yield* FiberSet.makeRuntimePromise<never>();
        // Handlers belong to the session: releasing it interrupts them, which is not a failure.
        const run: Run = (effect) => runPromise(effect).catch(() => undefined as never);
        const evidence = makeRequesterEvidence();
        const encodeThreadId = (key: {
          guildId: string;
          parentChannelId: string;
          threadId: string;
        }) =>
          adapter.encodeThreadId({
            guildId: key.guildId,
            channelId: key.parentChannelId,
            threadId: key.threadId,
          });
        const post = (key: Parameters<typeof encodeThreadId>[0], text: string) =>
          adapter.post(encodeThreadId(key), text);
        const sender: DiscordSender = {
          applicationId,
          create: (destination, text, options) =>
            adapter.create(encodeThreadId(destination), text, options),
          edit: (destination, messageId, text) =>
            adapter.edit(encodeThreadId(destination), messageId, text),
          disable: (destination, messageId, customId, state) =>
            adapter.disable(encodeThreadId(destination), messageId, customId, state),
          reopen: (destination) => adapter.reopen(encodeThreadId(destination)),
          locked: (destination) => adapter.locked(encodeThreadId(destination)),
        };
        const engine = yield* makeInterpreter({
          sql,
          applicationId,
          generations,
          model: conversation.model,
          tools: conversation.tools,
          operating: () => !released(),
          post,
          typing: (key) => adapter.typing(encodeThreadId(key)),
          sender,
          actions: conversation.actions,
        });
        // The reply target a MESSAGE_CREATE carried, kept until admission takes it.
        const references = new Map<string, ReferencedMessage>();
        client.on(Events.Raw, (packet: { t?: string; d?: RawMessageCreate }) => {
          if (packet.t !== "MESSAGE_CREATE" || !packet.d?.message_reference) return;
          references.set(packet.d.id, {
            referenceType: packet.d.message_reference.type ?? 0,
            message: packet.d.referenced_message ?? null,
          });
          if (references.size > MAX_HELD_REFERENCES)
            references.delete(references.keys().next().value!);
        });
        const ingress = makeIngress(
          {
            sql,
            client,
            applicationId,
            evidence,
            generations,
            operating: () => !released(),
            startThread: (channelId, messageId) => adapter.startThread(channelId, messageId),
            handOff: (threadId, message) => adapter.handOff(threadId, message),
            encodeThreadId,
            post,
            confirm: conversation.actions.confirm,
            referenced: (messageId) => {
              const reference = references.get(messageId);
              references.delete(messageId);
              return reference;
            },
            publishedRun: publishedRun(sql, applicationId),
          },
          engine,
        );
        const admitted = (_thread: Thread, message: { id: string }) =>
          run(ingress.admitted(message.id));
        chat.onNewMention(admitted);
        chat.onSubscribedMessage(admitted);
        adapter.ingress = {
          message: (message) => run(ingress.message(message)),
          interaction: (interaction) => run(ingress.interaction(interaction)),
        };
        const changed = (guildId: string | null) => {
          if (guildId) evidence.changed(guildId);
        };
        client.on(Events.ShardReconnecting, () => {
          evidence.gap();
          void run(Effect.andThen(engine.transportDown, reconnecting));
        });
        client.on(Events.Invalidated, () => evidence.gap());
        const connected = () => {
          current = { ...current, connectionStatus: "connected", connectionProblem: null };
          void run(engine.transportUp);
        };
        client.on(Events.ShardResume, connected);
        client.on(Events.ShardReady, connected);
        client.on(Events.ChannelUpdate, (_, channel) =>
          changed("guildId" in channel ? channel.guildId : null),
        );
        client.on(Events.ChannelDelete, (channel) =>
          changed("guildId" in channel ? channel.guildId : null),
        );
        client.on(Events.ThreadUpdate, (_, thread) => changed(thread.guildId));
        client.on(Events.ThreadDelete, (thread) => changed(thread.guildId));
        client.on(Events.GuildRoleUpdate, (_, role) => changed(role.guild.id));
        client.on(Events.GuildRoleDelete, (role) => changed(role.guild.id));
        client.on(Events.GuildDelete, (guild) => changed(guild.id));
        // discord.js drops removals of members it never cached, so the raw dispatch is read instead.
        client.on(Events.Raw, (packet: { t?: string; d?: ThreadMembersUpdate }) => {
          if (packet.t !== "THREAD_MEMBERS_UPDATE" || !packet.d) return;
          const { guild_id, added_members = [], removed_member_ids = [] } = packet.d;
          if (removed_member_ids.length > 0 || added_members.length > 0) changed(guild_id);
        });
        adapter.listen(client, released);
        const session = { client, released };
        serving = session;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (serving === session) serving = undefined;
          }),
        );
        const commandSetup = yield* registerCommands(client, applicationId);
        current = { connectionStatus: "connected", connectionProblem: null, commandSetup };
        interpreter = engine;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (interpreter === engine) interpreter = undefined;
          }),
        );
        yield* engine.started;
        // Owed receipts go out only from a verified, serving session.
        yield* Effect.forkScoped(conversation.deliveries.serve(sender));
        yield* Effect.forkScoped(conversation.actions.serveButtons(sender));
        return yield* Effect.callback<GatewayResult>((resume) => {
          client.once(Events.ShardDisconnect, ({ code }) =>
            resume(Effect.succeed(closeResult(code))),
          );
        });
      });

    const reconnecting = Effect.gen(function* () {
      const occurredAt = yield* now;
      current = {
        ...current,
        connectionStatus: "reconnecting",
        connectionProblem: { ...RECONNECTING, occurredAt },
      };
    });

    /** One session from login to its end; `served` tells whether it became operational. */
    const attempt = (connection: DiscordConnection) =>
      gateway.operate(
        connection,
        {
          state: sqliteChatState(sql, Effect.runPromise),
          adapter: (config) => new FactoryDiscordAdapter(config),
        },
        (session) =>
          adoptApplication(sql, session.applicationId, session.botName).pipe(
            Effect.flatMap(conversation.actions.proposalsEnded),
            // Names are display only, so the lookup runs beside serving and never delays it.
            Effect.andThen(
              Effect.forkScoped(
                accessIds(sql).pipe(
                  Effect.flatMap((ids) => lookupNames(session.client, ids)),
                  Effect.flatMap((names) => recordNames(sql, names)),
                  Effect.ignore,
                ),
              ),
            ),
            Effect.andThen(serve(session)),
          ),
      );

    const supervise = Effect.gen(function* () {
      for (let failures = 0; ;) {
        const connection = yield* savedConnection;
        const ended = connection.ok
          ? yield* attempt(connection.value)
          : ({
              result: { outcome: "failed", message: connection.error.message, transient: false },
              served: false,
            } satisfies { result: GatewayResult; served: boolean });
        const occurredAt = yield* now;
        const { outcome, message, transient } = ended.result;
        if (!transient) {
          yield* sql`UPDATE chat_control_state SET rejected_outcome=${outcome},rejected_message=${message},rejected_at=${occurredAt} WHERE singleton=1 AND enabled=1`;
          return;
        }
        if (ended.served) failures = 0;
        current = {
          ...current,
          connectionStatus: "reconnecting",
          connectionProblem: { outcome, message, occurredAt },
        };
        yield* Effect.sleep(backoff(failures++));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.gen(function* () {
              const occurredAt = yield* now;
              yield* sql`UPDATE chat_control_state SET rejected_outcome='failed',rejected_message=${UNEXPECTED_STOP},rejected_at=${occurredAt} WHERE singleton=1 AND enabled=1`;
            }).pipe(Effect.ignore),
      ),
    );

    /** Starts a fresh supervisor, replacing any running one only after its session is released. */
    const start = Effect.gen(function* () {
      yield* FiberHandle.clear(supervisor);
      yield* sql`UPDATE chat_control_state SET rejected_outcome=NULL,rejected_message=NULL,rejected_at=NULL WHERE singleton=1`;
      current = { connectionStatus: "connecting", connectionProblem: null, commandSetup: null };
      yield* FiberHandle.run(supervisor, supervise);
    });

    const initial = yield* readState;
    if (initial.enabled === 1 && initial.rejected_outcome === null)
      yield* FiberHandle.run(supervisor, supervise);

    return {
      start,
      /** A committed Language model save discards the serving session's unfinished interpretation. */
      modelSaved: Effect.suspend(() => interpreter?.discardAll ?? Effect.void),
      /** Sends the access test from the serving session; one test at a time. */
      sendAccessTest: testing.withPermits(1)(
        Effect.suspend(() => {
          const session = serving;
          return session && !session.released()
            ? sendAccessTest(sql, session.client)
            : Effect.succeed(
                failure(
                  "conflict",
                  "Chat control isn’t connected to Discord. Send the access test once it is connected.",
                ),
              );
        }),
      ),
      /** Stops the supervisor and waits until its Gateway session is released. */
      stop: FiberHandle.clear(supervisor),
      /** The operating connection now, for a persisted On state. */
      status: Effect.map(readState, (row): OperationStatus =>
        row.rejected_outcome !== null && row.rejected_message !== null && row.rejected_at !== null
          ? {
              connectionStatus: "rejected",
              connectionProblem: {
                outcome: row.rejected_outcome,
                message: row.rejected_message,
                occurredAt: row.rejected_at,
              },
              commandSetup: current.commandSetup,
            }
          : current,
      ),
    };
  });

export type DiscordOperation = Effect.Success<ReturnType<typeof makeDiscordOperation>>;

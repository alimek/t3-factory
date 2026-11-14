import { DiscordAdapter } from "@chat-adapter/discord";
import { Message as ChatMessage, type Chat, type Thread } from "chat";
import { Events, type Client, type Interaction, type Message } from "discord.js";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
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
import { conversationGenerations } from "./conversations.ts";
import type { ChatCredentials } from "./credentials.ts";
import {
  closeResult,
  ready,
  type DiscordConnection,
  type DiscordGateway,
  type GatewayResult,
} from "./discord-gateway.ts";
import { acknowledge, makeIngress, registerCommands } from "./discord-ingress.ts";
import { makeRequesterEvidence } from "./requester-evidence.ts";

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
const backoff = (failures: number) => Duration.millis(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS));

const UNEXPECTED_STOP =
  "Chat control's Discord connection stopped unexpectedly. Retry to reconnect.";

/** An operating Gateway session with Factory's adapter and verified client. */
interface Session {
  readonly adapter: FactoryDiscordAdapter;
  readonly chat: Chat;
  readonly client: Client<true>;
  readonly released: () => boolean;
}

const RECONNECTING: Omit<DiscordConnectionProblem, "occurredAt"> = {
  outcome: "unreachable",
  message: "Discord closed the Gateway connection. Factory is reconnecting.",
};

/**
 * Chat control's operating Discord connection. While On, one supervisor fiber in the backend's
 * scope runs one Gateway session at a time through the gateway's single listener, verifies the
 * authenticated application before attaching any handler or registering the command, backs off
 * after transient failures and stops after failures that need correction, recording them so a
 * restart does not reconnect until the owner retries.
 */
export const makeDiscordOperation = (gateway: DiscordGateway, credentials: ChatCredentials) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
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
          application_id: string | null;
          public_key: string | null;
          token_stage: string | null;
        }>`SELECT application_id,public_key,token_stage FROM chat_discord_connection WHERE singleton=1`;
        const token = row!.token_stage
          ? yield* credentials.secret(row!.token_stage, "discord-token")
          : null;
        if (!row!.application_id || !row!.public_key || token === null)
          return failure(
            "conflict",
            "The saved bot token is missing from the host's protected credentials. Replace it, then retry.",
          );
        return {
          ok: true,
          value: { applicationId: row!.application_id, publicKey: row!.public_key, token },
        };
      }),
    );

    /** Serves one verified session until Discord ends it for good. */
    const serve = (
      { adapter, chat, client, released }: Session,
      connection: DiscordConnection,
    ) =>
      Effect.gen(function* () {
        const runPromise = yield* FiberSet.makeRuntimePromise<never>();
        // Handlers belong to the session: releasing it interrupts them, which is not a failure.
        const run: Run = (effect) =>
          runPromise(effect).catch(() => undefined as never);
        const evidence = makeRequesterEvidence();
        const ingress = makeIngress(
          {
            sql,
            client,
            applicationId: connection.applicationId,
            evidence,
            generations,
            operating: () => !released(),
            startThread: (channelId, messageId) => adapter.startThread(channelId, messageId),
            handOff: (threadId, message) => adapter.handOff(threadId, message),
            encodeThreadId: (key) =>
              adapter.encodeThreadId({
                guildId: key.guildId,
                channelId: key.parentChannelId,
                threadId: key.threadId,
              }),
          },
          acknowledge,
        );
        const admitted = (thread: Thread, message: { id: string }) =>
          run(ingress.admitted(thread, message.id));
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
          void run(reconnecting);
        });
        client.on(Events.Invalidated, () => evidence.gap());
        const connected = () => {
          current = { ...current, connectionStatus: "connected", connectionProblem: null };
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
          const { id, guild_id, added_members = [], removed_member_ids = [] } = packet.d;
          if (removed_member_ids.length > 0) evidence.left(guild_id, id, removed_member_ids);
          for (const member of added_members) evidence.joined(guild_id, id, member.user_id);
        });
        adapter.listen(client, released);
        const commandSetup = yield* registerCommands(client, connection.applicationId);
        current = { connectionStatus: "connected", connectionProblem: null, commandSetup };
        return yield* Effect.callback<GatewayResult>((resume) => {
          client.once(Events.ShardDisconnect, ({ code }) => resume(Effect.succeed(closeResult(code))));
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
        { state: sqliteChatState(sql, Effect.runPromise), adapter: (config) => new FactoryDiscordAdapter(config) },
        (session) =>
          Effect.gen(function* () {
            const established = yield* ready(session.client, connection);
            if (established.outcome !== "verified")
              return { result: established, served: false };
            const result = yield* serve(
              { ...session, client: session.client as Client<true> },
              connection,
            );
            return { result, served: true };
          }),
      );

    const supervise = Effect.gen(function* () {
      for (let failures = 0; ; ) {
        const connection = yield* savedConnection;
        const ended = connection.ok
          ? yield* attempt(connection.value)
          : {
              result: { outcome: "failed", message: connection.error.message, transient: false },
              served: false,
            } satisfies { result: GatewayResult; served: boolean };
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
      /** Stops the supervisor and waits until its Gateway session is released. */
      stop: FiberHandle.clear(supervisor),
      /** The operating connection now, for a persisted On state. */
      status: Effect.map(
        readState,
        (row): OperationStatus =>
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

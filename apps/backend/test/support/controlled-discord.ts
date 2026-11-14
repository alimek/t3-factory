import type { TestContext } from "@effect/vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/** A bot application Discord knows, addressed by its token. */
export interface ControlledDiscordBot {
  readonly token: string;
  readonly applicationId: string;
  /** The bot user's ID; Discord gives most applications the application's own ID. */
  readonly userId?: string;
  readonly username?: string;
  /** Whether the Developer Portal allows the privileged Message Content intent. */
  readonly messageContentIntent?: boolean;
}

/** A server the bot is a member of, with its text channels. */
export interface ControlledDiscordGuild {
  readonly id: string;
  readonly name: string;
  readonly channels: readonly { readonly id: string; readonly name: string }[];
}

/** One REST request as Discord received it; `path` omits the query, `body` is parsed JSON. */
interface DiscordRestRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A thread in a guild text channel. Discord gives a thread started from a message its ID. */
export interface ControlledDiscordThread {
  readonly id: string;
  readonly guildId: string;
  readonly parentId: string;
  readonly name: string;
  readonly private: boolean;
  /** User IDs Discord lists as thread members. */
  readonly members: Set<string>;
}

/** One Gateway connection as Discord saw it. */
interface GatewaySession {
  /** The token its IDENTIFY carried; null until it identified. */
  token: string | null;
  intents: number | null;
  ready: boolean;
  closed: boolean;
}

interface GatewayEvent {
  readonly t: string;
  readonly d: unknown;
}

const MESSAGE_CONTENT_INTENT = 1 << 15;

/** A Discord user, as message authors and mentions carry it. */
const user = (id: string, username: string, bot: boolean) => ({
  id,
  username,
  discriminator: "0",
  global_name: null,
  avatar: null,
  bot,
});

const threadPayload = (thread: ControlledDiscordThread) => ({
  id: thread.id,
  guild_id: thread.guildId,
  parent_id: thread.parentId,
  type: thread.private ? 12 : 11,
  name: thread.name,
  owner_id: "100000000000000001",
  member_count: thread.members.size,
  message_count: 0,
  thread_metadata: {
    archived: false,
    auto_archive_duration: 1440,
    archive_timestamp: new Date(0).toISOString(),
    locked: false,
  },
});

const guildCreate = (guild: ControlledDiscordGuild, threads: readonly ControlledDiscordThread[]) => ({
  id: guild.id,
  name: guild.name,
  icon: null,
  owner_id: "100000000000000001",
  unavailable: false,
  large: false,
  member_count: 1,
  joined_at: new Date(0).toISOString(),
  features: [],
  roles: [],
  emojis: [],
  stickers: [],
  members: [],
  presences: [],
  voice_states: [],
  threads: threads.filter((thread) => thread.guildId === guild.id).map(threadPayload),
  stage_instances: [],
  guild_scheduled_events: [],
  channels: guild.channels.map((channel, position) => ({
    id: channel.id,
    type: 0,
    guild_id: guild.id,
    name: channel.name,
    position,
    permission_overwrites: [],
  })),
});

/** A waiter list that resolves each waiter once its condition holds. */
function barriers() {
  const waiting: { condition: () => boolean; resolve: () => void }[] = [];
  return {
    wait(condition: () => boolean) {
      return new Promise<void>((resolve) => {
        if (condition()) resolve();
        else waiting.push({ condition, resolve });
      });
    },
    notify() {
      for (const waiter of waiting.splice(0))
        if (waiter.condition()) waiter.resolve();
        else waiting.push(waiter);
    },
  };
}

/**
 * Discord as Factory reaches it over the network: the REST API and the Gateway WebSocket, on
 * loopback. It is owned by the test or fixture rather than by Factory, so a backend restart cannot
 * reset it; it keeps guilds, threads and their members, records every REST request, Gateway session,
 * posted message, interaction reply and command registration, and offers explicit barriers instead
 * of timing assumptions.
 */
export async function startControlledDiscord() {
  const bots = new Map<string, ControlledDiscordBot>();
  const guilds: ControlledDiscordGuild[] = [];
  const threads = new Map<string, ControlledDiscordThread>();
  const requests: DiscordRestRequest[] = [];
  const sessions: GatewaySession[] = [];
  const sockets = new Map<GatewaySession, WebSocket>();
  /** Command registrations by application, as the last bulk overwrite set them. */
  const commands = new Map<string, unknown>();
  const changed = barriers();
  /** Events each session receives right after it becomes ready. */
  const trafficOnReady: GatewayEvent[] = [];
  let readyHeld = false;
  let threadMembersAvailable = true;
  let gatewayAvailable = true;
  let sequence = 0;
  let nextId = 900000000000000000n;
  const mintId = () => String(++nextId);

  const botUser = (bot: ControlledDiscordBot) =>
    user(bot.userId ?? bot.applicationId, bot.username ?? "Factory bot", true);
  const parentOf = (channelId: string) =>
    guilds.find((guild) => guild.channels.some((channel) => channel.id === channelId));

  const gatewayUrl = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
  const send = (socket: WebSocket, payload: Record<string, unknown>) =>
    socket.send(JSON.stringify({ s: null, t: null, ...payload }));
  const dispatch = (socket: WebSocket, event: GatewayEvent) =>
    send(socket, { op: 0, s: ++sequence, t: event.t, d: event.d });
  /** Delivers `event` to every ready, open Gateway session. */
  const deliver = (event: GatewayEvent) => {
    for (const [session, socket] of sockets)
      if (session.ready && !session.closed) dispatch(socket, event);
  };

  const route = (
    method: string,
    path: string,
    token: string,
    body: unknown,
  ): { status: number; body?: unknown } => {
    const bot = bots.get(token);
    const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (method === "GET" && path === "/api/v10/gateway/bot") {
      if (!bot) return { status: 401, body: { message: "401: Unauthorized", code: 0 } };
      if (!gatewayAvailable) return { status: 503, body: { message: "Service Unavailable", code: 0 } };
      return {
        status: 200,
        body: {
          url: gatewayUrl(),
          shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        },
      };
    }
    let match = /^\/api\/v10\/applications\/(\d+)\/commands$/.exec(path);
    if (method === "PUT" && match && bot) {
      commands.set(match[1]!, body);
      return {
        status: 200,
        body: (body as Record<string, unknown>[]).map((command) => ({
          ...command,
          id: mintId(),
          application_id: match![1],
          version: "1",
        })),
      };
    }
    match = /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path);
    if (method === "POST" && match && bot) {
      const guild = parentOf(match[1]!);
      if (!guild) return { status: 404, body: { message: "Unknown Channel", code: 10003 } };
      const thread: ControlledDiscordThread = {
        id: match[2]!,
        guildId: guild.id,
        parentId: match[1]!,
        name: typeof fields.name === "string" ? fields.name : "thread",
        private: false,
        members: new Set(),
      };
      threads.set(thread.id, thread);
      deliver({ t: "THREAD_CREATE", d: { ...threadPayload(thread), newly_created: true } });
      return { status: 201, body: threadPayload(thread) };
    }
    match = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(path);
    if (method === "POST" && match && bot)
      return {
        status: 200,
        body: {
          id: mintId(),
          type: 0,
          channel_id: match[1],
          content: fields.content ?? "",
          author: botUser(bot),
          timestamp: new Date(0).toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: fields.embeds ?? [],
          pinned: false,
        },
      };
    match = /^\/api\/v10\/channels\/(\d+)$/.exec(path);
    if (method === "GET" && match && bot) {
      const thread = threads.get(match[1]!);
      if (thread) return { status: 200, body: threadPayload(thread) };
      const guild = parentOf(match[1]!);
      if (!guild) return { status: 404, body: { message: "Unknown Channel", code: 10003 } };
      return { status: 200, body: { id: match[1], type: 0, guild_id: guild.id, name: "channel" } };
    }
    match = /^\/api\/v10\/channels\/(\d+)\/thread-members\/(\d+)$/.exec(path);
    if (method === "GET" && match && bot) {
      if (!threadMembersAvailable)
        return { status: 503, body: { message: "Service Unavailable", code: 0 } };
      if (!threads.get(match[1]!)?.members.has(match[2]!))
        return { status: 404, body: { message: "Unknown Member", code: 10007 } };
      return {
        status: 200,
        body: { id: match[1], user_id: match[2], join_timestamp: new Date(0).toISOString(), flags: 0 },
      };
    }
    if (method === "POST" && /^\/api\/v10\/interactions\/\d+\/[^/]+\/callback$/.test(path))
      return { status: 204 };
    match = /^\/api\/v10\/webhooks\/(\d+)\/[^/]+\/messages\/(?:@|%40)original$/.exec(path);
    if (method === "PATCH" && match)
      return {
        status: 200,
        body: {
          id: mintId(),
          type: 20,
          channel_id: "0",
          content: fields.content ?? "",
          author: user(match[1]!, "Factory bot", true),
          timestamp: new Date(0).toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          flags: 64,
        },
      };
    return { status: 404, body: { message: "404: Not Found", code: 0 } };
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body: unknown = text && request.headers["content-type"]?.includes("json") ? JSON.parse(text) : null;
      const path = (request.url ?? "").split("?")[0]!;
      requests.push({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization,
        body,
      });
      const token = request.headers.authorization?.replace(/^Bot /, "") ?? "";
      const answer = route(request.method ?? "", path, token, body);
      if (answer.body === undefined) response.writeHead(answer.status).end();
      else {
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      }
      changed.notify();
    });
  });

  const gateway = new WebSocketServer({ server, path: "/gateway" });

  const becomeReady = (session: GatewaySession, socket: WebSocket, bot: ControlledDiscordBot) => {
    session.ready = true;
    dispatch(socket, {
      t: "READY",
      d: {
        v: 10,
        user: botUser(bot),
        guilds: guilds.map((guild) => ({ id: guild.id, unavailable: true })),
        session_id: `controlled-session-${sessions.indexOf(session)}`,
        resume_gateway_url: gatewayUrl(),
        application: { id: bot.applicationId, flags: 0 },
        shard: [0, 1],
      },
    });
    for (const guild of guilds)
      dispatch(socket, { t: "GUILD_CREATE", d: guildCreate(guild, [...threads.values()]) });
    for (const event of trafficOnReady) dispatch(socket, event);
    changed.notify();
  };

  gateway.on("connection", (socket) => {
    const session: GatewaySession = { token: null, intents: null, ready: false, closed: false };
    sessions.push(session);
    sockets.set(session, socket);
    socket.on("close", () => {
      session.closed = true;
      changed.notify();
    });
    socket.on("message", (data: Buffer) => {
      const packet = JSON.parse(data.toString("utf8")) as {
        op: number;
        d: { token?: string; intents?: number };
      };
      if (packet.op === 1) return send(socket, { op: 11 });
      // A resumed session continues where it was; Discord replays nothing Factory missed here.
      if (packet.op === 6) {
        session.token = packet.d.token ?? "";
        if (!bots.has(session.token)) return socket.close(4004, "Authentication failed.");
        session.ready = true;
        dispatch(socket, { t: "RESUMED", d: {} });
        return changed.notify();
      }
      if (packet.op !== 2) return;
      session.token = packet.d.token ?? "";
      session.intents = packet.d.intents ?? 0;
      changed.notify();
      const bot = bots.get(session.token);
      if (!bot) return socket.close(4004, "Authentication failed.");
      if (session.intents & MESSAGE_CONTENT_INTENT && !bot.messageContentIntent)
        return socket.close(4014, "Disallowed intent(s).");
      if (!readyHeld) becomeReady(session, socket, bot);
    });
    send(socket, { op: 10, d: { heartbeat_interval: 41_250 } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requested = (method: string, path: RegExp) =>
    requests.filter((request) => request.method === method && path.test(request.path));
  return {
    /** The REST API base Factory is configured with in place of https://discord.com/api. */
    apiUrl: `${origin}/api`,
    requests,
    sessions,
    commands,
    trafficOnReady,
    addBot(bot: ControlledDiscordBot) {
      bots.set(bot.token, { messageContentIntent: true, ...bot });
    },
    /** Removes a bot application, as when its token is reset in the Developer Portal. */
    removeBot(token: string) {
      bots.delete(token);
    },
    addGuild(guild: ControlledDiscordGuild) {
      guilds.push(guild);
    },
    /** Adds a thread; ready sessions learn about it as Discord announces new threads. */
    addThread(thread: Omit<ControlledDiscordThread, "members"> & { members: readonly string[] }) {
      const added = { ...thread, members: new Set(thread.members) };
      threads.set(thread.id, added);
      deliver({ t: "THREAD_CREATE", d: { ...threadPayload(added), newly_created: true } });
    },
    /**
     * Removes a member from a thread. Discord announces it only to bots with the Server Members
     * intent, which Factory does not request, unless `announce` says otherwise.
     */
    removeThreadMember(threadId: string, userId: string, announce = false) {
      const thread = threads.get(threadId)!;
      thread.members.delete(userId);
      if (announce)
        deliver({
          t: "THREAD_MEMBERS_UPDATE",
          d: {
            id: threadId,
            guild_id: thread.guildId,
            member_count: thread.members.size,
            removed_member_ids: [userId],
          },
        });
    },
    /** Makes Gateway discovery fail as a Discord outage does. */
    setGatewayAvailable(available: boolean) {
      gatewayAvailable = available;
    },
    /** Makes thread-member lookups fail as an outage does. */
    setThreadMembersAvailable(available: boolean) {
      threadMembersAvailable = available;
    },
    /** Delivers a Gateway event to every ready session. */
    deliver,
    /** Closes every open session with a resumable code; clients resume on a new connection. */
    interruptSessions() {
      for (const [session, socket] of sockets)
        if (!session.closed) socket.close(4000, "Unknown error.");
    },
    /** Later sessions identify but receive no READY until `releaseReady`. */
    holdReady() {
      readyHeld = true;
    },
    /** Lets every identified, waiting session become ready. */
    releaseReady() {
      readyHeld = false;
      for (const [session, socket] of sockets)
        if (session.token !== null && !session.ready && !session.closed) {
          const bot = bots.get(session.token);
          if (bot) becomeReady(session, socket, bot);
        }
    },
    /** REST requests with `method` whose path matches `path`. */
    requested,
    /** Resolves once at least `count` requests with `method` matched `path`. */
    request(method: string, path: RegExp, count = 1) {
      return changed.wait(() => requested(method, path).length >= count);
    },
    /** Resolves once `count` sessions have identified. */
    identified(count = 1) {
      return changed.wait(
        () => sessions.filter((session) => session.token !== null).length >= count,
      );
    },
    /** Resolves once `count` sessions have become ready, by identifying or resuming. */
    readied(count = 1) {
      return changed.wait(() => sessions.filter((session) => session.ready).length >= count);
    },
    /** Resolves once every session that connected so far has disconnected. */
    disconnected() {
      return changed.wait(() => sessions.every((session) => session.closed));
    },
    async close() {
      for (const client of gateway.clients) client.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type ControlledDiscord = Awaited<ReturnType<typeof startControlledDiscord>>;

/** A controlled Discord for one test, closed when it finishes. */
export async function controlledDiscord(context: TestContext) {
  const discord = await startControlledDiscord();
  context.onTestFinished(() => discord.close());
  return discord;
}

export const PARTICIPANT_ID = "200000000000000001";

/** A guild MESSAGE_CREATE. By default a human participant mentions the bot. */
export function messageEvent(options: {
  readonly bot: ControlledDiscordBot;
  readonly guildId: string;
  /** A parent channel or a thread. */
  readonly channelId: string;
  readonly id: string;
  readonly authorId?: string;
  readonly content?: string;
  readonly mention?: boolean;
  readonly replyToBot?: boolean;
  readonly authorIsBot?: boolean;
  readonly webhook?: boolean;
}): GatewayEvent {
  const botUser = user(
    options.bot.userId ?? options.bot.applicationId,
    options.bot.username ?? "Factory bot",
    true,
  );
  const mention = options.mention ?? !options.replyToBot;
  const message = {
    id: options.id,
    type: options.replyToBot ? 19 : 0,
    channel_id: options.channelId,
    guild_id: options.guildId,
    author: user(options.authorId ?? PARTICIPANT_ID, "participant", options.authorIsBot ?? false),
    content: `${mention ? `<@${botUser.id}> ` : ""}${options.content ?? "list my Projects"}`,
    timestamp: new Date(0).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: mention ? [botUser] : [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    ...(options.webhook ? { webhook_id: "700000000000000001" } : {}),
  };
  if (!options.replyToBot) return { t: "MESSAGE_CREATE", d: message };
  const replied = {
    ...message,
    id: "700000000000000002",
    type: 0,
    author: botUser,
    content: "An earlier reply.",
    mentions: [],
  };
  return {
    t: "MESSAGE_CREATE",
    d: {
      ...message,
      message_reference: {
        type: 0,
        message_id: replied.id,
        channel_id: options.channelId,
        guild_id: options.guildId,
      },
      referenced_message: replied,
    },
  };
}

/** View Channels, Send Messages and Read Message History. */
export const MEMBER_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 16n);

/** An INTERACTION_CREATE for `/factory reset` used by `userId` in `channel`. */
export function resetCommandEvent(options: {
  readonly bot: ControlledDiscordBot;
  readonly guildId: string;
  readonly channel:
    | { readonly id: string }
    | { readonly id: string; readonly parentId: string; readonly private: boolean };
  readonly id: string;
  readonly userId?: string;
  /** What Discord computed for the member in this channel, overwrites included. */
  readonly permissions?: bigint;
}): GatewayEvent {
  const userId = options.userId ?? PARTICIPANT_ID;
  const channel =
    "parentId" in options.channel
      ? threadPayload({
          id: options.channel.id,
          guildId: options.guildId,
          parentId: options.channel.parentId,
          name: "thread",
          private: options.channel.private,
          members: new Set(),
        })
      : { id: options.channel.id, type: 0, guild_id: options.guildId, name: "factory" };
  return {
    t: "INTERACTION_CREATE",
    d: {
      id: options.id,
      application_id: options.bot.applicationId,
      type: 2,
      token: `interaction-token-${options.id}`,
      version: 1,
      guild_id: options.guildId,
      channel_id: options.channel.id,
      channel,
      member: {
        user: user(userId, "participant", false),
        roles: [],
        joined_at: new Date(0).toISOString(),
        deaf: false,
        mute: false,
        flags: 0,
        permissions: String(options.permissions ?? MEMBER_PERMISSIONS),
      },
      app_permissions: String(MEMBER_PERMISSIONS),
      locale: "en-US",
      guild_locale: "en-US",
      entitlements: [],
      authorizing_integration_owners: { "0": options.guildId },
      context: 0,
      data: {
        id: "800000000000000001",
        name: "factory",
        type: 1,
        options: [{ name: "reset", type: 1, options: [] }],
      },
    },
  };
}

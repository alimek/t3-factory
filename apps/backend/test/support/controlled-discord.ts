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

/** One REST request as Discord received it. */
interface DiscordRestRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
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

const guildCreate = (guild: ControlledDiscordGuild) => ({
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
  threads: [],
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
 * Discord as Factory reaches it over the network: the REST API that announces the Gateway and the
 * Gateway WebSocket itself, on loopback. It is owned by the test or fixture rather than by
 * Factory, so a backend restart cannot reset it; it records every REST request and Gateway
 * session and offers explicit barriers instead of timing assumptions.
 */
export async function startControlledDiscord() {
  const bots = new Map<string, ControlledDiscordBot>();
  const guilds: ControlledDiscordGuild[] = [];
  const requests: DiscordRestRequest[] = [];
  const sessions: GatewaySession[] = [];
  const sockets = new Map<GatewaySession, WebSocket>();
  const changed = barriers();
  /** Events each session receives right after it becomes ready. */
  const trafficOnReady: GatewayEvent[] = [];
  let readyHeld = false;
  let sequence = 0;

  const server = createServer((request, response) => {
    request.resume();
    const path = request.url ?? "";
    requests.push({
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
    });
    const token = request.headers.authorization?.replace(/^Bot /, "") ?? "";
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && path === "/api/v10/gateway/bot") {
      if (!bots.has(token)) return answer(401, { message: "401: Unauthorized", code: 0 });
      return answer(200, {
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      });
    }
    answer(404, { message: "404: Not Found", code: 0 });
  });

  const gateway = new WebSocketServer({ server, path: "/gateway" });
  const send = (socket: WebSocket, payload: Record<string, unknown>) =>
    socket.send(JSON.stringify({ s: null, t: null, ...payload }));
  const dispatch = (socket: WebSocket, event: GatewayEvent) =>
    send(socket, { op: 0, s: ++sequence, t: event.t, d: event.d });

  const becomeReady = (session: GatewaySession, socket: WebSocket, bot: ControlledDiscordBot) => {
    session.ready = true;
    const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
    dispatch(socket, {
      t: "READY",
      d: {
        v: 10,
        user: user(bot.userId ?? bot.applicationId, bot.username ?? "Factory bot", true),
        guilds: guilds.map((guild) => ({ id: guild.id, unavailable: true })),
        session_id: `controlled-session-${sessions.indexOf(session)}`,
        resume_gateway_url: origin,
        application: { id: bot.applicationId, flags: 0 },
        shard: [0, 1],
      },
    });
    for (const guild of guilds) dispatch(socket, { t: "GUILD_CREATE", d: guildCreate(guild) });
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
  return {
    /** The REST API base Factory is configured with in place of https://discord.com/api. */
    apiUrl: `${origin}/api`,
    requests,
    sessions,
    trafficOnReady,
    addBot(bot: ControlledDiscordBot) {
      bots.set(bot.token, { messageContentIntent: true, ...bot });
    },
    addGuild(guild: ControlledDiscordGuild) {
      guilds.push(guild);
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
    /** Resolves once `count` sessions have identified. */
    identified(count = 1) {
      return changed.wait(
        () => sessions.filter((session) => session.token !== null).length >= count,
      );
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

/** A controlled Discord for one test, closed when it finishes. */
export async function controlledDiscord(context: TestContext) {
  const discord = await startControlledDiscord();
  context.onTestFinished(() => discord.close());
  return discord;
}

/** A guild text message from a human that mentions the bot, as MESSAGE_CREATE carries it. */
export function mentionEvent(
  bot: ControlledDiscordBot,
  guild: ControlledDiscordGuild,
  text: string,
): GatewayEvent {
  const botUser = user(bot.userId ?? bot.applicationId, bot.username ?? "Factory bot", true);
  return {
    t: "MESSAGE_CREATE",
    d: {
      id: "300000000000000001",
      type: 0,
      channel_id: guild.channels[0]!.id,
      guild_id: guild.id,
      author: user("200000000000000001", "participant", false),
      content: `<@${botUser.id}> ${text}`,
      timestamp: new Date(0).toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [botUser],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
    },
  };
}

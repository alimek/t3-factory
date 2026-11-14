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
export interface DiscordRestRequest {
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
  archived?: boolean;
  locked?: boolean;
}

/** One Gateway connection as Discord saw it. */
export interface GatewaySession {
  /** The token its IDENTIFY carried; null until it identified. */
  token: string | null;
  intents: number | null;
  ready: boolean;
  closed: boolean;
}

type Answer = {
  readonly status: number;
  readonly body?: unknown;
  /** The connection drops after Discord acted on the request, so no answer arrives. */
  readonly lost?: boolean;
  /** No answer arrives until the server closes. */
  readonly held?: boolean;
  /** No answer arrives until `releaseMessages`; then Discord handles the request normally. */
  readonly paused?: boolean;
};

/**
 * How Discord treats one later message create or edit: `delivered` proceeds normally,
 * `refused` answers 403 Missing Access,
 * `rate-limited` answers 429, `lost` creates the message (or finds the one its enforced nonce
 * names) and drops the connection before answering, `failed` answers 500 after creating nothing,
 * `held` never answers and creates nothing, and `paused` (creates only) waits until
 * `releaseMessages` and then proceeds normally.
 */
export type MessageFault =
  | "delivered"
  | "refused"
  | "rate-limited"
  | "lost"
  | "failed"
  | "held"
  | "paused";

/**
 * Faults that leave one create unproven on Factory's first request and on both re-attempts it
 * makes with the same enforced nonce, so its outcome stays unknown.
 */
export const unproven = (fault: "lost" | "failed"): MessageFault[] => [fault, fault, fault];

/** A message Discord created, with its components, as it shows it now. */
export interface CreatedMessage {
  readonly id: string;
  readonly channelId: string;
  /** The current text: edits replace it. */
  content: string;
  /** The current components: edits and interaction updates replace them. */
  components: unknown;
  /** The application whose bot authored it. */
  readonly applicationId: string;
  deleted: boolean;
}
type Fields = Record<string, unknown>;

/**
 * How Factory answered one interaction: privately (an ephemeral reply or follow-up), or by
 * updating the message whose component was clicked, with the components it shows now.
 */
export type InteractionAnswer =
  | { readonly interactionId: string; readonly kind: "ephemeral"; readonly content: string }
  | { readonly interactionId: string; readonly kind: "updated"; readonly components: unknown };

/** A REST request matched to a route, with its parsed body and the bot its token belongs to. */
interface RouteRequest {
  readonly match: RegExpExecArray;
  readonly fields: Fields;
  readonly body: unknown;
  readonly bot: ControlledDiscordBot;
  /** A paused request Discord now handles; its fault was already taken. */
  readonly resumed: boolean;
}

export interface GatewayEvent {
  readonly t: string;
  readonly d: unknown;
}

const MESSAGE_CONTENT_INTENT = 1 << 15;
/** The interaction callback type acknowledging a component click by a later message update. */
const DEFERRED_UPDATE_MESSAGE = 6;
const EPHEMERAL = 1 << 6;

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
    archived: thread.archived === true,
    auto_archive_duration: 1440,
    archive_timestamp: new Date(0).toISOString(),
    locked: thread.locked === true,
  },
});

const guildCreate = (
  guild: ControlledDiscordGuild,
  threads: readonly ControlledDiscordThread[],
) => ({
  id: guild.id,
  name: guild.name,
  icon: null,
  owner_id: "100000000000000001",
  unavailable: false,
  large: false,
  member_count: 1,
  joined_at: new Date(0).toISOString(),
  features: [],
  // Everyone may view and post in every channel unless the test removes them from the server.
  roles: [
    {
      id: guild.id,
      name: "@everyone",
      permissions: "3072",
      position: 0,
      color: 0,
      hoist: false,
      managed: false,
      mentionable: false,
      flags: 0,
    },
  ],
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
  /** Each application's global commands, as bulk overwrites and single-command upserts left them. */
  const commands = new Map<string, Record<string, unknown>[]>();
  const changed = barriers();
  /** Events each session receives right after it becomes ready. */
  const trafficOnReady: GatewayEvent[] = [];
  let readyHeld = false;
  let threadMembersAvailable = true;
  let resumeHeld = false;
  let resumeAttempts = 0;
  const heldResumes: [GatewaySession, WebSocket][] = [];
  /** Users who left every server; Discord answers Unknown Member for them. */
  const departed = new Set<string>();
  let gatewayAvailable = true;
  let typingAvailable = true;
  const messageFaults: MessageFault[] = [];
  const editFaults: MessageFault[] = [];
  const created: CreatedMessage[] = [];
  /** Messages by their author's application and the nonce Discord enforced for them. */
  const nonces = new Map<string, CreatedMessage>();
  /** Answers paused creates once `releaseMessages` is called. */
  const pausedCreates: (() => void)[] = [];
  /** Every text edit Discord applied, in order. */
  const edits: { readonly messageId: string; readonly content: string }[] = [];
  /** Every edit of a message's components Discord applied, in order. */
  const componentEdits: { readonly messageId: string; readonly components: unknown }[] = [];
  /** Interactions by token: the clicked message and how Factory acknowledged them. */
  const interactions = new Map<
    string,
    { readonly id: string; readonly messageId?: string; callbackType?: number }
  >();
  const interactionAnswers: InteractionAnswer[] = [];
  const deletedThreads = new Set<string>();
  let activeThreadLimitReached = false;
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
    if (event.t === "INTERACTION_CREATE") {
      const interaction = event.d as { id: string; token: string; message?: { id: string } };
      interactions.set(interaction.token, {
        id: interaction.id,
        ...(interaction.message ? { messageId: interaction.message.id } : {}),
      });
    }
    for (const [session, socket] of sockets)
      if (session.ready && !session.closed) dispatch(socket, event);
  };

  const unknownChannel: Answer = { status: 404, body: { message: "Unknown Channel", code: 10003 } };
  const unknownMessage: Answer = { status: 404, body: { message: "Unknown Message", code: 10008 } };
  const locked: Answer = { status: 403, body: { message: "Thread is locked", code: 160005 } };
  const archived: Answer = { status: 400, body: { message: "Thread is archived", code: 50083 } };
  /** A fault's answer, or undefined when the request proceeds. */
  const faultAnswer = (fault: MessageFault | undefined): Answer | undefined => {
    if (fault === "refused")
      return { status: 403, body: { message: "Missing Access", code: 50001 } };
    if (fault === "rate-limited")
      return {
        status: 429,
        body: { message: "You are being rate limited.", retry_after: 0.01, global: false },
      };
    if (fault === "failed") return { status: 500, body: { message: "Internal", code: 0 } };
    if (fault === "held") return { status: 0, held: true };
    return undefined;
  };
  const unavailable: Answer = { status: 503, body: { message: "Service Unavailable", code: 0 } };
  const sentMessage = (channelId: string, author: object, fields: Fields, extra: object = {}) => ({
    id: mintId(),
    type: 0,
    channel_id: channelId,
    content: fields.content ?? "",
    author,
    timestamp: new Date(0).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: fields.embeds ?? [],
    pinned: false,
    ...extra,
  });

  /** The key Discord remembers an enforced nonce under: per authoring application. */
  const enforcedNonce = (fields: Fields, bot: ControlledDiscordBot) =>
    fields.enforce_nonce === true && typeof fields.nonce === "string"
      ? `${bot.applicationId}\n${fields.nonce}`
      : undefined;

  /**
   * The message a create makes in `channelId`. An enforced nonce the same author used recently
   * returns that earlier message instead, creating nothing.
   */
  const createdOnce = (channelId: string, fields: Fields, bot: ControlledDiscordBot) => {
    const nonce = enforcedNonce(fields, bot);
    const earlier = nonce === undefined ? undefined : nonces.get(nonce);
    if (earlier)
      return sentMessage(earlier.channelId, botUser(bot), fields, {
        id: earlier.id,
        components: earlier.components,
      });
    const message = sentMessage(channelId, botUser(bot), fields, {
      components: fields.components ?? [],
    });
    const entry: CreatedMessage = {
      id: message.id,
      channelId,
      content: typeof fields.content === "string" ? fields.content : "",
      components: fields.components ?? [],
      applicationId: bot.applicationId,
      deleted: false,
    };
    created.push(entry);
    if (nonce !== undefined) nonces.set(nonce, entry);
    return message;
  };

  /** Each bot-authorized REST route Factory uses: method, path and Discord's answer. */
  const routes: readonly (readonly [string, RegExp, (request: RouteRequest) => Answer])[] = [
    [
      "GET",
      /^\/api\/v10\/gateway\/bot$/,
      () =>
        gatewayAvailable
          ? {
              status: 200,
              body: {
                url: gatewayUrl(),
                shards: 1,
                session_start_limit: {
                  total: 1000,
                  remaining: 1000,
                  reset_after: 0,
                  max_concurrency: 1,
                },
              },
            }
          : unavailable,
    ],
    [
      "PUT",
      /^\/api\/v10\/applications\/(\d+)\/commands$/,
      ({ match, body }) => {
        commands.set(match[1]!, body as Record<string, unknown>[]);
        return {
          status: 200,
          body: (body as Record<string, unknown>[]).map((command) => ({
            ...command,
            id: mintId(),
            application_id: match[1],
            version: "1",
          })),
        };
      },
    ],
    [
      "POST",
      /^\/api\/v10\/applications\/(\d+)\/commands$/,
      ({ match, body }) => {
        // Discord creates the command or updates the one with the same name; others stay.
        const command = body as Record<string, unknown>;
        const existing = commands.get(match[1]!) ?? [];
        const kept = existing.filter((other) => other.name !== command.name);
        commands.set(match[1]!, [...kept, command]);
        return {
          status: kept.length === existing.length ? 201 : 200,
          body: { ...command, id: mintId(), application_id: match[1], version: "1" },
        };
      },
    ],
    [
      "POST",
      /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)\/threads$/,
      ({ match, fields }) => {
        const guild = parentOf(match[1]!);
        if (!guild) return unknownChannel;
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
      },
    ],
    [
      "POST",
      /^\/api\/v10\/channels\/(\d+)\/messages$/,
      ({ match, fields, bot, resumed }) => {
        const fault = resumed ? undefined : messageFaults.shift();
        if (fault === "paused") return { status: 0, paused: true };
        const faulted = faultAnswer(fault);
        if (faulted) return faulted;
        if (deletedThreads.has(match[1]!)) return unknownChannel;
        const thread = threads.get(match[1]!);
        if (thread?.locked) return locked;
        // Posting in an archived thread that is not locked reopens it.
        if (thread) thread.archived = false;
        return { status: 200, body: createdOnce(match[1]!, fields, bot), lost: fault === "lost" };
      },
    ],
    [
      "POST",
      /^\/api\/v10\/channels\/(\d+)\/typing$/,
      ({ match }) => {
        if (!typingAvailable) return unavailable;
        if (deletedThreads.has(match[1]!)) return unknownChannel;
        return { status: 204 };
      },
    ],
    [
      "PATCH",
      /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/,
      ({ match, fields, bot }) => {
        const fault = editFaults.shift();
        const faulted = faultAnswer(fault);
        if (faulted) return faulted;
        if (deletedThreads.has(match[1]!)) return unknownChannel;
        const message = created.find(
          (entry) => entry.id === match[2] && entry.channelId === match[1] && !entry.deleted,
        );
        if (!message) return unknownMessage;
        if (message.applicationId !== bot.applicationId)
          return {
            status: 403,
            body: { message: "Cannot edit a message authored by another user", code: 50005 },
          };
        const thread = threads.get(match[1]!);
        if (thread?.locked) return locked;
        if (thread?.archived) return archived;
        if (typeof fields.content === "string") {
          message.content = fields.content;
          edits.push({ messageId: message.id, content: message.content });
        }
        if (fields.components !== undefined) {
          message.components = fields.components;
          componentEdits.push({ messageId: message.id, components: message.components });
        }
        return {
          status: 200,
          body: sentMessage(match[1]!, botUser(bot), fields, { id: message.id }),
          lost: fault === "lost",
        };
      },
    ],
    [
      "PATCH",
      /^\/api\/v10\/channels\/(\d+)$/,
      ({ match, fields }) => {
        const thread = threads.get(match[1]!);
        if (!thread || deletedThreads.has(thread.id)) return unknownChannel;
        if (thread.locked) return locked;
        if (fields.archived === false && thread.archived && activeThreadLimitReached)
          return {
            status: 400,
            body: { message: "Maximum number of active threads reached", code: 160006 },
          };
        if (typeof fields.archived === "boolean") thread.archived = fields.archived;
        return { status: 200, body: threadPayload(thread) };
      },
    ],
    [
      "GET",
      /^\/api\/v10\/channels\/(\d+)$/,
      ({ match }) => {
        if (deletedThreads.has(match[1]!)) return unknownChannel;
        const thread = threads.get(match[1]!);
        if (thread) return { status: 200, body: threadPayload(thread) };
        const guild = parentOf(match[1]!);
        return guild
          ? { status: 200, body: { id: match[1], type: 0, guild_id: guild.id, name: "channel" } }
          : unknownChannel;
      },
    ],
    [
      "GET",
      /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)$/,
      ({ match }) =>
        departed.has(match[2]!)
          ? { status: 404, body: { message: "Unknown Member", code: 10007 } }
          : {
              status: 200,
              body: {
                user: user(match[2]!, "participant", false),
                roles: [],
                joined_at: new Date(0).toISOString(),
                deaf: false,
                mute: false,
                flags: 0,
              },
            },
    ],
    [
      "GET",
      /^\/api\/v10\/channels\/(\d+)\/thread-members\/(\d+)$/,
      ({ match }) => {
        if (!threadMembersAvailable) return unavailable;
        if (!threads.get(match[1]!)?.members.has(match[2]!))
          return { status: 404, body: { message: "Unknown Member", code: 10007 } };
        const member = { id: match[1], user_id: match[2], flags: 0 };
        return { status: 200, body: { ...member, join_timestamp: new Date(0).toISOString() } };
      },
    ],
  ];

  /** An interaction's reply or follow-up message; ephemeral ones are recorded as answers. */
  const privateAnswer = (
    applicationId: string,
    interaction: { readonly id: string } | undefined,
    fields: Fields,
    message: { readonly type: number; readonly flags: number },
  ): Answer => {
    if (
      interaction &&
      (message.flags & EPHEMERAL) === EPHEMERAL &&
      typeof fields.content === "string"
    )
      interactionAnswers.push({
        interactionId: interaction.id,
        kind: "ephemeral",
        content: fields.content,
      });
    return {
      status: 200,
      body: sentMessage("0", user(applicationId, "Factory bot", true), fields, {
        ...message,
        embeds: [],
      }),
    };
  };

  /** Interaction responses authenticate with the interaction's token instead of the bot's. */
  const interactionRoutes: readonly (readonly [
    string,
    RegExp,
    (request: Omit<RouteRequest, "bot" | "resumed">) => Answer,
  ])[] = [
    [
      "POST",
      /^\/api\/v10\/interactions\/\d+\/([^/]+)\/callback$/,
      ({ match, fields }) => {
        const interaction = interactions.get(match[1]!);
        if (interaction) interaction.callbackType = fields.type as number;
        return { status: 204 };
      },
    ],
    [
      "PATCH",
      /^\/api\/v10\/webhooks\/(\d+)\/([^/]+)\/messages\/(?:@|%40)original$/,
      ({ match, fields }) => {
        const interaction = interactions.get(match[2]!);
        // After a deferred message update, the original is the message whose component was used.
        if (interaction?.callbackType === DEFERRED_UPDATE_MESSAGE) {
          const message = created.find((entry) => entry.id === interaction.messageId);
          if (!message) return unknownMessage;
          if (fields.components !== undefined) message.components = fields.components;
          if (typeof fields.content === "string") message.content = fields.content;
          interactionAnswers.push({
            interactionId: interaction.id,
            kind: "updated",
            components: message.components,
          });
          return {
            status: 200,
            body: sentMessage(message.channelId, user(match[1]!, "Factory bot", true), fields, {
              id: message.id,
              components: message.components,
            }),
          };
        }
        return privateAnswer(match[1]!, interaction, fields, { type: 20, flags: EPHEMERAL });
      },
    ],
    [
      "POST",
      /^\/api\/v10\/webhooks\/(\d+)\/([^/]+)$/,
      ({ match, fields }) => {
        return privateAnswer(match[1]!, interactions.get(match[2]!), fields, {
          type: 0,
          flags: Number(fields.flags ?? 0),
        });
      },
    ],
  ];

  const route = (
    method: string,
    path: string,
    token: string,
    body: unknown,
    resumed = false,
  ): Answer => {
    const bot = bots.get(token);
    const fields = (typeof body === "object" && body !== null ? body : {}) as Fields;
    for (const [routeMethod, pattern, answer] of interactionRoutes) {
      const match = routeMethod === method ? pattern.exec(path) : null;
      if (match) return answer({ match, fields, body });
    }
    for (const [routeMethod, pattern, answer] of routes) {
      const match = routeMethod === method ? pattern.exec(path) : null;
      if (!match) continue;
      if (!bot) return { status: 401, body: { message: "401: Unauthorized", code: 0 } };
      return answer({ match, fields, body, bot, resumed });
    }
    return { status: 404, body: { message: "404: Not Found", code: 0 } };
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body: unknown =
        text && request.headers["content-type"]?.includes("json") ? JSON.parse(text) : null;
      const path = (request.url ?? "").split("?")[0]!;
      requests.push({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization,
        body,
      });
      const token = request.headers.authorization?.replace(/^Bot /, "") ?? "";
      const respond = (answer: Answer) => {
        if (answer.held) return changed.notify();
        if (answer.lost) response.destroy();
        else if (answer.body === undefined) response.writeHead(answer.status).end();
        else {
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(JSON.stringify(answer.body));
        }
        changed.notify();
      };
      const answer = route(request.method ?? "", path, token, body);
      if (!answer.paused) return respond(answer);
      pausedCreates.push(() => respond(route(request.method ?? "", path, token, body, true)));
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

  const resume = (session: GatewaySession, socket: WebSocket) => {
    session.ready = true;
    dispatch(socket, { t: "RESUMED", d: {} });
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
        resumeAttempts += 1;
        if (resumeHeld) {
          heldResumes.push([session, socket]);
          return changed.notify();
        }
        return resume(session, socket);
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
    /** Messages Discord created, in order. */
    created,
    /** Later message creates meet these faults in order, one each. */
    faultMessages(...faults: MessageFault[]) {
      messageFaults.push(...faults);
    },
    /** Discord handles and answers every paused create now. */
    releaseMessages() {
      for (const answer of pausedCreates.splice(0)) answer();
    },
    /** Discord's few-minute nonce uniqueness window passed: earlier nonces return nothing. */
    nonceWindowPassed() {
      nonces.clear();
    },
    /** Resolves once Discord created `count` messages in total. */
    createdMessages(count: number) {
      return changed.wait(() => created.length >= count);
    },
    /** Resolves once `count` created messages satisfy `matches`. */
    createdWhere(matches: (message: CreatedMessage) => boolean, count: number) {
      return changed.wait(() => created.filter(matches).length >= count);
    },
    /** Every message text edit Discord applied, in order. */
    edits,
    /** Every edit of a message's components (its buttons) Discord applied, in order. */
    componentEdits,
    /** How Factory answered interactions, in order. */
    interactionAnswers,
    /** Resolves once Factory answered `count` interactions in total. */
    answered(count: number) {
      return changed.wait(() => interactionAnswers.length >= count);
    },
    /** Resolves once Discord applied `count` component edits in total. */
    componentsEdited(count: number) {
      return changed.wait(() => componentEdits.length >= count);
    },
    /** Later message edits meet these faults in order, one each. */
    faultEdits(...faults: MessageFault[]) {
      editFaults.push(...faults);
    },
    /** Resolves once `matches` holds for Discord's messages, re-checked after every request. */
    messagesWhen(matches: (messages: readonly CreatedMessage[]) => boolean) {
      return changed.wait(() => matches(created));
    },
    /** A moderator deletes a message: edits of it answer Unknown Message from now on. */
    deleteMessage(id: string) {
      created.find((message) => message.id === id)!.deleted = true;
    },
    /** The thread is archived (and locked, if asked), as Discord does after inactivity. */
    archiveThread(id: string, options: { readonly locked?: boolean } = {}) {
      const thread = threads.get(id)!;
      thread.archived = true;
      thread.locked = options.locked === true;
    },
    /** A moderator unlocks the thread; it stays archived until something reopens it. */
    unlockThread(id: string) {
      threads.get(id)!.locked = false;
    },
    /** Whether Discord shows the thread archived now. */
    threadArchived(id: string) {
      return threads.get(id)?.archived === true;
    },
    /** The thread is deleted: Discord answers Unknown Channel for it. */
    deleteThread(id: string) {
      deletedThreads.add(id);
    },
    /** Reopening archived threads fails: the server reached Discord's active thread limit. */
    setActiveThreadLimitReached(reached: boolean) {
      activeThreadLimitReached = reached;
    },
    /** Makes Gateway discovery fail as a Discord outage does. */
    setGatewayAvailable(available: boolean) {
      gatewayAvailable = available;
    },
    /** Makes typing indicator triggers fail as an outage does. */
    setTypingAvailable(available: boolean) {
      typingAvailable = available;
    },
    /** Makes thread-member lookups fail as an outage does. */
    /** The user leaves every server; lookups of them answer Unknown Member. */
    removeGuildMember(userId: string) {
      departed.add(userId);
    },
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
    /** Later resume attempts wait without RESUMED until `releaseResume`: the outage continues. */
    holdResume() {
      resumeHeld = true;
    },
    /** Answers every waiting resume attempt and lets later ones resume at once. */
    releaseResume() {
      resumeHeld = false;
      for (const [session, socket] of heldResumes.splice(0))
        if (!session.closed) resume(session, socket);
    },
    /** Resolves once clients attempted `count` resumes in total. */
    resumeAttempted(count = 1) {
      return changed.wait(() => resumeAttempts >= count);
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
      server.closeAllConnections();
      for (const client of gateway.clients) client.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type ControlledDiscord = Awaited<ReturnType<typeof startControlledDiscord>>;

/** A controlled Discord for one test, closed when it finishes. */
export async function controlledDiscord(context: TestContext): Promise<ControlledDiscord> {
  const discord = await startControlledDiscord();
  context.onTestFinished(() => discord.close());
  return discord;
}

export const PARTICIPANT_ID = "200000000000000001";

/** A message payload replying to `target`, with the referenced message as Discord carries it. */
function replyPayload(
  message: Record<string, unknown> & { readonly guild_id: string },
  target: NonNullable<Parameters<typeof messageEvent>[0]["replyTo"]>,
) {
  return {
    ...message,
    type: 19,
    message_reference: {
      type: 0,
      message_id: target.id,
      channel_id: target.channelId,
      guild_id: message.guild_id,
    },
    referenced_message:
      target.content === null
        ? null
        : {
            ...message,
            id: target.id,
            type: target.type ?? 0,
            channel_id: target.channelId,
            author: user(target.authorId, "author", target.authorIsBot ?? false),
            content: target.content,
            mentions: [],
          },
  };
}

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
  /**
   * A reply to another message, carried in the payload as Discord does; `null` content models a
   * target Discord could not supply, such as a deleted message.
   */
  readonly replyTo?: {
    readonly id: string;
    readonly channelId: string;
    readonly authorId: string;
    readonly content: string | null;
    readonly authorIsBot?: boolean;
    readonly type?: number;
  };
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
  if (options.replyTo) return { t: "MESSAGE_CREATE", d: replyPayload(message, options.replyTo) };
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
const MEMBER_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 16n);

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

/** The member payload interactions carry: the user and what Discord computed in the channel. */
const interactionMember = (userId: string, permissions: bigint) => ({
  user: user(userId, "participant", false),
  roles: [],
  joined_at: new Date(0).toISOString(),
  deaf: false,
  mute: false,
  flags: 0,
  permissions: String(permissions),
});

/** An INTERACTION_CREATE for a click on a message button with `customId` in a thread. */
export function buttonEvent(options: {
  readonly bot: ControlledDiscordBot;
  readonly guildId: string;
  readonly thread: { readonly id: string; readonly parentId: string; readonly private?: boolean };
  readonly id: string;
  readonly customId: string;
  readonly userId?: string;
  /** What Discord computed for the member in this channel, overwrites included. */
  readonly permissions?: bigint;
  /** The message carrying the button, as Discord shows it now. */
  readonly message?: Pick<CreatedMessage, "id" | "content" | "components">;
}): GatewayEvent {
  const botUser = user(
    options.bot.userId ?? options.bot.applicationId,
    options.bot.username ?? "Factory bot",
    true,
  );
  const channel = threadPayload({
    id: options.thread.id,
    guildId: options.guildId,
    parentId: options.thread.parentId,
    name: "thread",
    private: options.thread.private ?? false,
    members: new Set(),
  });
  return {
    t: "INTERACTION_CREATE",
    d: {
      id: options.id,
      application_id: options.bot.applicationId,
      type: 3,
      token: `interaction-token-${options.id}`,
      version: 1,
      guild_id: options.guildId,
      channel_id: options.thread.id,
      channel,
      member: interactionMember(
        options.userId ?? PARTICIPANT_ID,
        options.permissions ?? MEMBER_PERMISSIONS,
      ),
      app_permissions: String(MEMBER_PERMISSIONS),
      locale: "en-US",
      guild_locale: "en-US",
      entitlements: [],
      authorizing_integration_owners: { "0": options.guildId },
      context: 0,
      message: {
        id: options.message?.id ?? "800000000000000002",
        type: 0,
        channel_id: options.thread.id,
        content: options.message?.content ?? "Confirm",
        author: botUser,
        timestamp: new Date(0).toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        components: options.message?.components ?? [],
        flags: 0,
      },
      data: { custom_id: options.customId, component_type: 2 },
    },
  };
}

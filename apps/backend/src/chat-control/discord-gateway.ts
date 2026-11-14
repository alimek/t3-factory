import { createDiscordAdapter } from "@chat-adapter/discord";
import { Chat, ConsoleLogger, type StateAdapter } from "chat";
import {
  Client,
  DiscordjsErrorCodes,
  Events,
  GatewayCloseCodes,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type { DiscordCheckOutcome } from "@t3-factory/contracts";
import { releasableShardingStrategy } from "./discord-shards.ts";

/** Discord's public REST API; the Gateway address comes from its answer. */
export const DISCORD_API_URL = "https://discord.com/api";
const CHECK_TIMEOUT = Duration.seconds(30);

/** One complete saved connection with its resolved token. */
export interface DiscordConnection {
  readonly applicationId: string;
  readonly publicKey: string;
  readonly token: string;
}

interface DiscordCheckResult {
  readonly outcome: DiscordCheckOutcome;
  readonly message: string;
}

// The intents the adapter's own Gateway listener requests. The check asks for the same ones, so a
// missing Message Content intent fails the check rather than later operation.
const GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
];

const silent = new ConsoleLogger("silent");

const refuse = () =>
  Promise.reject(new Error("A connection-only Discord session keeps no conversation state."));

/**
 * Chat SDK state for a session that admits nothing. Every data operation fails, so a handler that
 * somehow ran during a check could not subscribe, lock, deduplicate or queue anything.
 */
const connectionOnlyState: StateAdapter = {
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  subscribe: refuse,
  unsubscribe: refuse,
  isSubscribed: refuse,
  acquireLock: refuse,
  extendLock: refuse,
  releaseLock: refuse,
  forceReleaseLock: refuse,
  get: refuse,
  set: refuse,
  delete: refuse,
  setIfNotExists: refuse,
  appendToList: refuse,
  getList: refuse,
  enqueue: refuse,
  dequeue: refuse,
  queueDepth: refuse,
};

const result = (outcome: DiscordCheckOutcome, message: string): DiscordCheckResult => ({
  outcome,
  message,
});

const TOKEN_REJECTED = result(
  "token-rejected",
  "Discord rejected the saved bot token. Copy a current token from the Bot page and replace it.",
);

/** Factory's own reading of a Gateway close that ends the session for good. */
function closeResult(code: number): DiscordCheckResult {
  if (code === GatewayCloseCodes.AuthenticationFailed) return TOKEN_REJECTED;
  if (code === GatewayCloseCodes.DisallowedIntents)
    return result(
      "intent-disallowed",
      "Discord refused the Message Content intent. Turn on Message Content Intent on the application's Bot page.",
    );
  return result("failed", `Discord closed the Gateway connection (code ${code}).`);
}

/**
 * Factory's own reading of a failed login. Error texts and bodies can echo request details, so
 * only a category and an HTTP status leave here.
 */
function loginResult(error: unknown): DiscordCheckResult {
  if (error instanceof Error && "code" in error && error.code === DiscordjsErrorCodes.TokenInvalid)
    return TOKEN_REJECTED;
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (typeof status === "number")
    return result("failed", `Discord answered HTTP ${status} when Factory asked for the Gateway.`);
  return result("unreachable", "Factory could not reach Discord.");
}

/** The authenticated application's identity compared with the configured Application ID. */
function identityResult(expected: string, actual: string): DiscordCheckResult {
  if (actual !== expected)
    return result(
      "identity-mismatch",
      `The token belongs to Discord application ${actual}, not the configured Application ID ${expected}. Factory will not operate another application's bot.`,
    );
  return result(
    "verified",
    `Discord accepted the token for application ${actual} and the Gateway session became ready. Factory disconnected after the check.`,
  );
}

/**
 * The Chat SDK instance with the pinned Discord adapter and the discord.js Gateway client that
 * carries its listener. Release destroys the client, which ends the Gateway listener, and then shuts
 * Chat SDK down: Chat SDK shutdown alone leaves this adapter's Gateway open.
 */
const gatewaySession = (connection: DiscordConnection, apiUrl: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      // Every option is explicit, so the adapter never falls back to DISCORD_* environment values.
      const adapter = createDiscordAdapter({
        apiUrl: `${apiUrl}/v10`,
        applicationId: connection.applicationId,
        botToken: connection.token,
        publicKey: connection.publicKey,
        mentionRoleIds: [],
        respondToChannelIds: [],
        respondToGlobalMentions: false,
        logger: silent,
      });
      const chat = new Chat({
        userName: "factory",
        adapters: { discord: adapter },
        state: connectionOnlyState,
        logger: silent,
      });
      await chat.initialize();
      // Set before the client is destroyed, so a login still in progress opens nothing afterwards.
      let released = false;
      const client = new Client({
        intents: GATEWAY_INTENTS,
        partials: [Partials.Channel],
        rest: { api: apiUrl },
        ws: { buildStrategy: (manager) => releasableShardingStrategy(manager, () => released) },
      });
      // An emitted "error" without a listener would throw; failures are classified elsewhere.
      client.on(Events.Error, () => undefined);
      return { chat, client, release: () => (released = true) };
    }),
    ({ chat, client, release }) =>
      Effect.promise(async () => {
        release();
        await client.destroy();
        await chat.shutdown();
      }),
  );

/**
 * Logs in with exactly the saved token and waits for actual Gateway readiness. The adapter's own
 * listener swallows login failures, so readiness and failure are observed on the client directly.
 */
const establish = (client: Client, connection: DiscordConnection) =>
  Effect.callback<DiscordCheckResult>((resume) => {
    client.once(Events.ClientReady, (ready) =>
      resume(Effect.succeed(identityResult(connection.applicationId, ready.application.id))),
    );
    client.once(Events.ShardDisconnect, ({ code }) => resume(Effect.succeed(closeResult(code))));
    client.login(connection.token).catch((error: unknown) => {
      resume(Effect.succeed(loginResult(error)));
    });
  });

/**
 * The single owner of Chat control's Discord Gateway listener. Every session runs as a fiber in the
 * backend's scope, so closing Factory interrupts it and awaits its release, and at most one session
 * exists at a time: a request while one runs is refused rather than opening a second listener.
 */
export const makeDiscordGateway = (apiUrl: string) =>
  Effect.gen(function* () {
    const sessions = yield* FiberSet.make<Option.Option<DiscordCheckResult>>();
    const listener = yield* Semaphore.make(1);
    let checking = false;

    /**
     * A bounded connection-only session: it verifies readiness and the authenticated application,
     * then disconnects. No conversation handler is attached, so it handles no message, interaction
     * or command and sends nothing to Discord beyond the login itself.
     */
    const runCheck = (connection: DiscordConnection) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* gatewaySession(connection, apiUrl);
          const established = yield* establish(client, connection).pipe(
            Effect.timeoutOption(CHECK_TIMEOUT),
          );
          return Option.getOrElse(established, () =>
            result(
              "timed-out",
              `The Gateway session did not become ready within ${Duration.toSeconds(CHECK_TIMEOUT)} seconds.`,
            ),
          );
        }),
      );

    /**
     * None when another session holds the listener. The session fiber itself holds the listener,
     * so a caller that stops waiting cannot let a second session start while this one runs.
     */
    const check = (connection: DiscordConnection) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(
          sessions,
          listener.withPermitsIfAvailable(1)(
            Effect.sync(() => (checking = true)).pipe(
              Effect.andThen(runCheck(connection)),
              Effect.ensuring(Effect.sync(() => (checking = false))),
            ),
          ),
        );
        return yield* Fiber.join(fiber);
      });

    return { check, isChecking: () => checking };
  });

export type DiscordGateway = Effect.Success<ReturnType<typeof makeDiscordGateway>>;

import type { DiscordAdapter, DiscordAdapterConfig } from "@chat-adapter/discord";
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
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { DiscordCheckOutcome } from "@t3-factory/contracts";
import { releasableShardingStrategy } from "./discord-shards.ts";

/** Discord's public REST API; the Gateway address comes from its answer. */
export const DISCORD_API_URL = "https://discord.com/api";
const READY_TIMEOUT = Duration.seconds(30);

/** One complete saved connection with its resolved token. */
export interface DiscordConnection {
  readonly publicKey: string;
  readonly token: string;
}

/** How one session attempt ended. A transient failure may succeed later without any correction. */
export interface GatewayResult {
  readonly outcome: DiscordCheckOutcome;
  readonly message: string;
  readonly transient: boolean;
}

/**
 * A login's outcome: a ready session of the application Discord authenticated the token as, or
 * why there is none.
 */
export type Readiness =
  | { readonly ready: true; readonly applicationId: string }
  | { readonly ready: false; readonly result: GatewayResult };

/** The latest connection-only check's evidence. */
export interface CheckResult {
  readonly outcome: DiscordCheckOutcome;
  readonly applicationId: string | null;
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

const result = (
  outcome: DiscordCheckOutcome,
  message: string,
  transient = outcome === "unreachable" || outcome === "timed-out",
): GatewayResult => ({ outcome, message, transient });

const TOKEN_REJECTED = result(
  "token-rejected",
  "Discord rejected the saved bot token. Copy a current token from the Bot page and replace it.",
);

/** Factory's own reading of a Gateway close that ends the session for good. */
export function closeResult(code: number): GatewayResult {
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
function loginResult(error: unknown): GatewayResult {
  if (error instanceof Error && "code" in error && error.code === DiscordjsErrorCodes.TokenInvalid)
    return TOKEN_REJECTED;
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (typeof status === "number")
    return result(
      "failed",
      `Discord answered HTTP ${status} when Factory asked for the Gateway.`,
      status === 429 || status >= 500,
    );
  return result("unreachable", "Factory could not reach Discord.");
}

const failed = (gatewayResult: GatewayResult): Readiness => ({
  ready: false,
  result: gatewayResult,
});

/** What an operating session runs with besides the connection: its Chat SDK state and adapter. */
interface SessionParts<Adapter extends DiscordAdapter> {
  readonly state: StateAdapter;
  readonly adapter: (config: DiscordAdapterConfig) => Adapter;
}

/**
 * The discord.js Gateway client of one session. Release destroys it, which ends the Gateway
 * listener, and then shuts down the Chat SDK instance an operating session attached: Chat SDK
 * shutdown alone leaves the adapter's Gateway open.
 */
const gatewayClient = (apiUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      // Set before the client is destroyed, so a login still in progress opens nothing afterwards.
      let released = false;
      let chat: Chat | undefined;
      const client = new Client({
        intents: GATEWAY_INTENTS,
        partials: [Partials.Channel],
        rest: { api: apiUrl },
        ws: { buildStrategy: (manager) => releasableShardingStrategy(manager, () => released) },
      });
      // An emitted "error" without a listener would throw; failures are classified elsewhere.
      client.on(Events.Error, () => undefined);
      return {
        client,
        released: () => released,
        release: () => (released = true),
        attach: (attached: Chat) => (chat = attached),
        chat: () => chat,
      };
    }),
    ({ client, release, chat }) =>
      Effect.promise(async () => {
        release();
        await client.destroy();
        await chat()?.shutdown();
      }),
  );

/**
 * Logs in with exactly the saved token and waits for actual Gateway readiness. The adapter's own
 * listener swallows login failures, so readiness and failure are observed on the client directly.
 * The application is the one Discord reports for the authenticated session; the token is never
 * decoded.
 */
const establish = (client: Client, token: string) =>
  Effect.callback<Readiness>((resume) => {
    client.once(Events.ClientReady, (ready) =>
      resume(Effect.succeed({ ready: true, applicationId: ready.application.id })),
    );
    client.once(Events.ShardDisconnect, ({ code }) =>
      resume(Effect.succeed(failed(closeResult(code)))),
    );
    client.login(token).catch((error: unknown) => {
      resume(Effect.succeed(failed(loginResult(error))));
    });
  });

/** Logs in and waits at most 30 seconds for a ready Gateway session. */
const ready = (client: Client, token: string) =>
  Effect.map(establish(client, token).pipe(Effect.timeoutOption(READY_TIMEOUT)), (established) =>
    Option.getOrElse(established, () =>
      failed(
        result(
          "timed-out",
          `The Gateway session did not become ready within ${Duration.toSeconds(READY_TIMEOUT)} seconds.`,
        ),
      ),
    ),
  );

/**
 * The Chat SDK instance with the pinned Discord adapter for the authenticated application. Every
 * option is explicit, so the adapter never falls back to DISCORD_* environment values.
 */
const chatFor = async <Adapter extends DiscordAdapter>(
  connection: DiscordConnection,
  applicationId: string,
  apiUrl: string,
  parts: SessionParts<Adapter>,
) => {
  const adapter = parts.adapter({
    apiUrl: `${apiUrl}/v10`,
    applicationId,
    botToken: connection.token,
    publicKey: connection.publicKey,
    mentionRoleIds: [],
    respondToChannelIds: [],
    respondToGlobalMentions: false,
    logger: silent,
  });
  // Factory serializes conversations itself; see chat-state.ts.
  const chat = new Chat({
    userName: "factory",
    adapters: { discord: adapter },
    state: parts.state,
    concurrency: "concurrent",
    logger: silent,
  });
  await chat.initialize();
  return { adapter, chat };
};

/** An operating session whose application Discord authenticated, before any handler is attached. */
export interface OperatingSession<Adapter extends DiscordAdapter> {
  readonly applicationId: string;
  readonly adapter: Adapter;
  readonly chat: Chat;
  readonly client: Client<true>;
  readonly released: () => boolean;
}

/** How an operating session ended; `served` tells whether it became ready and was used. */
export interface OperatingResult {
  readonly result: GatewayResult;
  readonly served: boolean;
}

/**
 * The single owner of Chat control's Discord Gateway listener. Every session holds the one listener
 * permit for its whole life, so at most one session exists at a time. Checks run as fibers in the
 * backend's scope, so closing Factory interrupts them and awaits their release; the operating
 * connection runs in its supervisor's fiber, also in the backend's scope.
 */
export const makeDiscordGateway = (apiUrl: string) =>
  Effect.gen(function* () {
    const sessions = yield* FiberSet.make<Option.Option<CheckResult>>();
    const listener = yield* Semaphore.make(1);
    let checking = false;

    /**
     * A bounded connection-only session: it verifies readiness and reports the authenticated
     * application, then disconnects. It has no Chat SDK instance or handler, so it handles no
     * message, interaction or command and sends nothing to Discord beyond the login itself.
     */
    const runCheck = (connection: DiscordConnection) =>
      Effect.scoped(
        Effect.gen(function* (): Effect.fn.Return<CheckResult, never, Scope.Scope> {
          const { client } = yield* gatewayClient(apiUrl);
          const readiness = yield* ready(client, connection.token);
          if (!readiness.ready)
            return {
              outcome: readiness.result.outcome,
              applicationId: null,
              message: readiness.result.message,
            };
          return {
            outcome: "verified",
            applicationId: readiness.applicationId,
            message: `Discord accepted the token for application ${readiness.applicationId} and the Gateway session became ready. Factory disconnected after the check.`,
          };
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

    /**
     * Runs `use` with an operating session once the listener is free, waiting for a running check
     * to end first. Nothing of the session is built beyond the bare client until Discord has
     * authenticated it and reported its application. The session is released when `use` ends or
     * is interrupted.
     */
    const operate = <Adapter extends DiscordAdapter, E>(
      connection: DiscordConnection,
      parts: SessionParts<Adapter>,
      use: (session: OperatingSession<Adapter>) => Effect.Effect<GatewayResult, E, Scope.Scope>,
    ) =>
      listener.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* (): Effect.fn.Return<OperatingResult, E, Scope.Scope> {
            const session = yield* gatewayClient(apiUrl);
            const readiness = yield* ready(session.client, connection.token);
            if (!readiness.ready) return { result: readiness.result, served: false };
            // Attached in one uninterruptible step, so the session's release always shuts it down.
            const { adapter, chat } = yield* Effect.uninterruptible(
              Effect.map(
                Effect.promise(() => chatFor(connection, readiness.applicationId, apiUrl, parts)),
                (built) => {
                  session.attach(built.chat);
                  return built;
                },
              ),
            );
            const result = yield* use({
              applicationId: readiness.applicationId,
              adapter,
              chat,
              client: session.client as Client<true>,
              released: session.released,
            });
            return { result, served: true };
          }),
        ),
      );

    return { check, operate, isChecking: () => checking };
  });

export type DiscordGateway = Effect.Success<ReturnType<typeof makeDiscordGateway>>;

import { periodicWorker } from "./periodic.ts";
import * as Semaphore from "effect/Semaphore";
import { now } from "./time.ts";
import { newId } from "./ids.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthorizationContext, Result, T3Connection } from "@t3-factory/contracts";
import type { T3Adapter, T3ConnectionReason } from "./adapters/t3.ts";

type ContextRow = {
  id: string;
  endpoint: string;
  authorization_identity: string;
  environment_id: string;
  created_at: string;
};
const contextValue = (row: ContextRow): AuthorizationContext => ({
  id: row.id,
  endpoint: row.endpoint,
  environmentId: row.environment_id,
  createdAt: row.created_at,
});
const explanations: Record<T3ConnectionReason, string> = {
  connected:
    "T3 connection is ready. Project, harness and runtime execution readiness still require separate checks.",
  "approval-required":
    "Approve access in T3 by opening authorization on the Factory host; consent happens in that computer's browser. No token copying is needed.",
  "approval-pending":
    "Approve access in the browser opened on the backend host. Factory will recheck automatically.",
  "browser-unavailable":
    "Factory could not open the backend-host browser. Check its desktop/browser setup and choose Authorize again.",
  "callback-unavailable":
    "Factory could not bind the loopback OAuth callback on port 43827. Free that port and choose Authorize again.",
  "approval-expired":
    "OAuth approval expired or was denied. Choose Authorize to try again on the backend host.",
  "contract-missing":
    "T3 does not satisfy the connection contract. Inspect the reported problems, update T3 if needed, and recheck.",
};

/** Bounds how often anyone may open the host browser through `openConnectionAuthorization`. */
const AUTHORIZATION_OPEN_COOLDOWN_MS = 5_000;

const missingEndpoint = (message: string) => ({
  ok: false as const,
  error: { code: "validation" as const, message, issues: [] },
});

export const makeConnection = (t3: T3Adapter, intervalMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mutex = yield* Semaphore.make(1);
    const [savedRow] = yield* sql<{
      endpoint: string;
      context_id: string | null;
    }>`SELECT * FROM t3_connection WHERE singleton = 1`;
    let saved = savedRow;
    let current: ContextRow | undefined;
    if (saved?.context_id) {
      [current] =
        yield* sql<ContextRow>`SELECT * FROM t3_authorization_contexts WHERE id = ${saved.context_id}`;
    }
    let status: T3Connection = {
      endpoint: saved?.endpoint ?? null,
      state: "unavailable",
      explanation: "Save your T3 MCP endpoint to connect.",
      checkedAt: null,
      authorizationContext: current ? contextValue(current) : null,
      authorizationPending: false,
      contract: null,
    };
    let closed = false;
    /** When `openConnectionAuthorization` last asked the host browser; bounds repeated opens. */
    let lastOpenedAt: number | undefined;
    const value = (): Result<T3Connection> => ({ ok: true, value: status });
    // Once a mutation starts, shutdown drains it before closing the adapter and SQL.
    const serial = <A, E>(action: Effect.Effect<A, E>) =>
      mutex.withPermits(1)(Effect.uninterruptible(action));
    const check = Effect.fn("Connection.check")(function* () {
      if (!saved || closed) return value();
      const endpoint = saved.endpoint;
      return yield* Effect.gen(function* () {
        const observation = yield* Effect.tryPromise(() => t3.inspect({ endpoint }));
        const environment = observation.contract?.environmentId;
        if (
          observation.authorizationIdentity &&
          environment &&
          ["ready", "incompatible"].includes(observation.state)
        ) {
          if (
            !current ||
            current.authorization_identity !== observation.authorizationIdentity ||
            current.environment_id !== environment
          ) {
            const row: ContextRow = {
              id: yield* newId,
              endpoint,
              authorization_identity: observation.authorizationIdentity,
              environment_id: environment,
              created_at: yield* now,
            };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO t3_authorization_contexts (id, endpoint, authorization_identity, environment_id, created_at)
              VALUES (${row.id}, ${row.endpoint}, ${row.authorization_identity}, ${row.environment_id}, ${row.created_at})`;
                yield* sql`UPDATE t3_connection SET context_id = ${row.id} WHERE singleton = 1`;
              }),
            );
            current = row;
            saved!.context_id = row.id;
          }
        }
        status = {
          endpoint,
          state: observation.state,
          explanation: explanations[observation.reason],
          checkedAt: yield* now,
          authorizationContext: current ? contextValue(current) : null,
          authorizationPending: observation.reason === "approval-pending",
          contract: observation.contract ?? null,
        };
        if (status.state === "ready" && (!observation.authorizationIdentity || !environment)) {
          status = {
            ...status,
            state: "incompatible",
            explanation:
              "T3 did not provide a verifiable authorization context and environment. Reauthorize and recheck.",
          };
        }
        return value();
      }).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            status = {
              ...status,
              state: "unavailable",
              checkedAt: yield* now,
              authorizationPending: false,
              contract: null,
              explanation:
                "T3 is unavailable. Start T3 or check the endpoint and network. Factory will reconnect automatically.",
            };
            return value();
          }),
        ),
      );
    });
    /** Retires the current context and starts a new approval attempt; callers hold the mutex. */
    const startAuthorization = Effect.fn("Connection.startAuthorization")(function* (endpoint: {
      endpoint: string;
      context_id: string | null;
    }) {
      yield* sql`UPDATE t3_connection SET context_id = NULL WHERE singleton = 1`;
      endpoint.context_id = null;
      current = undefined;
      status = {
        ...status,
        authorizationContext: null,
        authorizationPending: false,
        contract: null,
        state: "authorization-required",
      };
      return yield* Effect.tryPromise(() => t3.authorize({ endpoint: endpoint.endpoint })).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
              status = {
                ...status,
                explanation:
                  "Authorization could not start. Check T3, backend-host browser and loopback callback port 43827, then authorize again.",
              };
              return value();
            }),
          onSuccess: () => check(),
        }),
      );
    });
    yield* check();
    const stopWorker = yield* periodicWorker(intervalMs, serial(check()), serial(Effect.void));
    const close = Effect.gen(function* () {
      if (closed) return;
      closed = true;
      yield* stopWorker;
      yield* Effect.tryPromise(() => t3.close());
    });
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    return {
      getConnection: () => Effect.sync(value),
      recheckConnection: () => serial(check()),
      configureConnection: (input: unknown) =>
        serial(
          Effect.gen(function* () {
            const parsed = parseEndpoint(input);
            if (!parsed.ok) return parsed;
            const endpoint = parsed.value;
            if (saved?.endpoint !== endpoint) {
              yield* sql`INSERT INTO t3_connection (singleton, endpoint, context_id) VALUES (1, ${endpoint}, NULL)
          ON CONFLICT(singleton) DO UPDATE SET endpoint = excluded.endpoint, context_id = NULL`;
              saved = { endpoint, context_id: null };
              current = undefined;
              status = { ...status, endpoint, authorizationContext: null, contract: null };
            }
            return yield* check();
          }),
        ),
      authorizeConnection: () =>
        serial(
          Effect.gen(function* () {
            if (!saved) return missingEndpoint("Save a T3 endpoint before authorizing.");
            return yield* startAuthorization(saved);
          }),
        ),
      openConnectionAuthorization: () =>
        serial(
          Effect.gen(function* () {
            if (!saved)
              return missingEndpoint(
                "The Factory host has no T3 endpoint yet. Save it on the Factory host first.",
              );
            const endpoint = saved;
            // Fresh evidence first: an approval that just completed is never replaced.
            yield* check();
            if (status.state !== "authorization-required") return value();
            const at = yield* Clock.currentTimeMillis;
            if (lastOpenedAt !== undefined && at - lastOpenedAt < AUTHORIZATION_OPEN_COOLDOWN_MS)
              return value();
            lastOpenedAt = at;
            const resumed = yield* Effect.tryPromise(() =>
              t3.resumeAuthorization({ endpoint: endpoint.endpoint }),
            ).pipe(Effect.option);
            if (resumed._tag === "None") {
              status = {
                ...status,
                explanation:
                  "Factory could not open the backend-host browser. The pending approval is unchanged; check the host's desktop/browser setup and try again.",
              };
              return value();
            }
            if (resumed.value !== "none") return yield* check();
            return yield* startAuthorization(endpoint);
          }),
        ),
      close,
    };
  });

function parseEndpoint(input: unknown): Result<string> {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      !("endpoint" in input) ||
      typeof input.endpoint !== "string"
    )
      throw new Error();
    const url = new URL(input.endpoint.trim());
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error();
    return { ok: true, value: url.href };
  } catch {
    return {
      ok: false,
      error: {
        code: "validation",
        message:
          "Use an HTTPS MCP endpoint, or HTTP on loopback, without credentials, query or fragment.",
        issues: [
          {
            code: "endpoint_invalid",
            path: "endpoint",
            message: "Enter the T3 MCP URL without secrets.",
          },
        ],
      },
    };
  }
}

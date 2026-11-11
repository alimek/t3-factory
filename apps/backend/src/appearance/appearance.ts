import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  AppearancePresentation,
  Result,
  T3Appearance,
  T3Connection,
} from "@t3-factory/contracts";
import { parseAppearancePresentation } from "@t3-factory/domain-validation";
import {
  AppearancePairingRejected,
  type AppearanceEvent,
  type AppearanceGrantRecord,
  type AppearanceStream,
  type T3Adapter,
} from "../adapters/t3.ts";
import type { LiveChanges } from "../live-changes.ts";
import { periodicWorker } from "../periodic.ts";
import { failure } from "../result.ts";
import { presentThemeModes } from "./palette-mapping.ts";
import { resolveBuiltInTheme, T3_RESOLVER_PIN } from "./t3-theme-palettes.ts";

/** Settings warns this long before the grant expires; T3 issues 30-day sessions. */
const EXPIRY_WARNING_MS = 7 * 24 * 3_600_000;
/** Clock difference tolerated between Factory and T3 when T3 refuses a grant near its expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** Pairing waits this long for T3's first configuration snapshot to confirm the environment. */
const FIRST_SNAPSHOT = "10 seconds";

const NOT_PAIRED =
  "Optional. Pair on the Factory host to use the T3 environment’s default theme colors in Light and Dark.";
const CONNECTING = "Reading the T3 environment’s default theme…";
const UNVERIFIABLE =
  "Theme colors wait for an authorized T3 connection to confirm the environment. Factory’s own colors are used meanwhile.";
const MISMATCH =
  "The paired T3 environment is not the one the T3 connection uses, so Factory’s own colors are used. Pair again with a code from the connected T3.";
const ENDED = {
  expired:
    "The theme-color grant expired, so Factory’s own colors are used. Pair again to keep following T3’s theme.",
  revoked:
    "T3 no longer accepts the theme-color grant: it was revoked. Factory’s own colors are used; pair again to keep following T3’s theme.",
} as const;
const outage = (retained: boolean) =>
  retained
    ? "T3 can’t be reached. Factory keeps the theme colors it received while the grant stays valid and reconnects automatically."
    : "T3 can’t be reached, so Factory’s own colors are used. Factory reconnects automatically.";

type PublishedTheme = { readonly id: string; readonly name: string };
/** What the current subscription last reported; every snapshot replaces it. */
type Source = {
  readonly environmentId: string;
  readonly defaultTheme: string;
  readonly themes: readonly PublishedTheme[];
};
/** One open subscription, bound to the T3 connection environment it was opened for. */
type Watch = { readonly stream: AppearanceStream; readonly environmentId: string };

function followingExplanation({ defaultTheme, themes }: Source) {
  if (!defaultTheme) return "T3 has no default theme, so Factory’s own colors are used.";
  const builtIn = resolveBuiltInTheme(defaultTheme);
  if (builtIn) return `Following T3’s default theme “${builtIn.name}”.`;
  const published = themes.find((theme) => theme.id === defaultTheme);
  return published
    ? `T3’s default theme “${published.name}” is a published theme. Factory follows built-in T3 themes only, so its own colors are used.`
    : `T3’s default theme “${defaultTheme}” is not available in T3, so Factory’s own colors are used.`;
}

const PAIRING_CODE = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const invalidPairing = (message: string) =>
  failure("validation", message, [{ code: "pairing_invalid", path: "pairing", message }]);

/**
 * The code a pasted pairing code or `/pair#token=` link carries. A link must belong to the T3
 * address of the connection, so a code minted elsewhere is refused before it is spent.
 */
function pairingCode(input: unknown, endpoint: string): Result<string> {
  const text =
    typeof input === "object" && input !== null && "pairing" in input
      ? typeof input.pairing === "string"
        ? input.pairing.trim()
        : ""
      : "";
  if (!/^https?:\/\//i.test(text))
    return PAIRING_CODE.test(text)
      ? { ok: true, value: text }
      : invalidPairing("Paste the pairing code or link T3 created for theme colors.");
  let link: URL;
  try {
    link = new URL(text);
  } catch {
    return invalidPairing("Paste the pairing code or link T3 created for theme colors.");
  }
  if (link.origin !== new URL(endpoint).origin)
    return invalidPairing(
      "This pairing link is for another T3 address. Create it on the T3 the connection uses.",
    );
  const code = new URLSearchParams(link.hash.slice(1)).get("token") ?? "";
  return PAIRING_CODE.test(code)
    ? { ok: true, value: code }
    : invalidPairing("This link carries no pairing code. Copy the whole link T3 printed.");
}

const pairingRefusals: Record<AppearancePairingRejected["reason"], string> = {
  "invalid-code":
    "T3 refused the pairing code: it is wrong, expired or already used. Create a new one and pair again.",
  "scope-not-granted":
    "This pairing does not include orchestration:read. Create it with --scope orchestration:read and pair again.",
  "unexpected-grant":
    "T3 granted something other than orchestration:read only, so Factory discarded it. Create a pairing with --scope orchestration:read.",
};

const revisionOf = (body: Omit<AppearancePresentation, "revision">) =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);

/**
 * Optional theme-color inheritance from the T3 connection's environment. It owns the separate
 * appearance grant's lifecycle and the one presentation approved clients receive, and never
 * affects connection readiness, Start, execution or Run attention.
 */
export const makeAppearance = (
  t3: T3Adapter,
  getConnection: () => Effect.Effect<Result<T3Connection>>,
  intervalMs: number,
  changes: LiveChanges,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sql = yield* SqlClient.SqlClient;
    const mutex = yield* Semaphore.make(1);
    const serial = <A, E>(action: Effect.Effect<A, E>) => mutex.withPermits(1)(action);
    let endpoint: string | null = null;
    let record: AppearanceGrantRecord | null = null;
    let watch: Watch | null = null;
    let source: Source | null = null;
    let presentation: AppearancePresentation | null = null;
    /** Why an active grant is not followed right now; null while following or connecting. */
    let problem: string | null = null;
    /** The connection environment a snapshot contradicted; no reconnect until it changes. */
    let refusedEnvironment: string | null = null;
    let binding: string | undefined;
    /** The stored snapshot's endpoint and revision; undefined until the first publication. */
    let stored: string | null | undefined;
    let status: T3Appearance = {
      state: "not-paired",
      explanation: NOT_PAIRED,
      grant: null,
      presentation: null,
    };

    /**
     * Keeps the one stored snapshot equal to the published presentation, so whatever ends the
     * colors (expiry, revocation, disconnect, another source, no default) also deletes it.
     */
    const store = Effect.gen(function* () {
      const key = endpoint && presentation ? `${endpoint}\n${presentation.revision}` : null;
      if (key === stored) return;
      if (endpoint && presentation)
        yield* sql`INSERT INTO appearance_snapshot (singleton, endpoint, presentation)
          VALUES (1, ${endpoint}, ${JSON.stringify(presentation)})
          ON CONFLICT (singleton) DO UPDATE SET
            endpoint = excluded.endpoint, presentation = excluded.presentation`;
      else yield* sql`DELETE FROM appearance_snapshot`;
      stored = key;
    }).pipe(Effect.orDie);

    /**
     * The snapshot a previous process stored, when it is still bound to this endpoint,
     * environment, grant and resolver.
     */
    const restore = (target: string, environment: string, grant: AppearanceGrantRecord["grant"]) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ endpoint: string; presentation: string }>`
          SELECT endpoint, presentation FROM appearance_snapshot WHERE singleton = 1`;
        if (row?.endpoint !== target) return null;
        const snapshot = yield* Effect.try(() =>
          parseAppearancePresentation(JSON.parse(row.presentation)),
        ).pipe(Effect.orElseSucceed(() => null));
        return snapshot?.environmentId === environment &&
          snapshot.grant.id === grant.id &&
          snapshot.grant.expiresAt === grant.expiresAt &&
          snapshot.resolverPin === T3_RESOLVER_PIN
          ? snapshot
          : null;
      }).pipe(Effect.orDie);

    const publish = Effect.gen(function* () {
      yield* store;
      const now = yield* Clock.currentTimeMillis;
      if (!record) {
        status = { state: "not-paired", explanation: NOT_PAIRED, grant: null, presentation: null };
      } else {
        const { pairedAt, expiresAt } = record.grant;
        const grant = {
          pairedAt,
          expiresAt,
          expiresSoon: Date.parse(expiresAt) - now <= EXPIRY_WARNING_MS,
        };
        if (record.status === "ended")
          status = {
            state: "re-pair-required",
            explanation: ENDED[record.reason],
            grant,
            presentation: null,
          };
        else if (problem)
          status = { state: "unavailable", explanation: problem, grant, presentation };
        else if (!source)
          status = { state: "connecting", explanation: CONNECTING, grant, presentation };
        else
          status = {
            state: "following",
            explanation: followingExplanation(source),
            grant,
            presentation,
          };
      }
      changes.appearanceChanged();
    });

    /** Resolves and validates both modes of the current default into one presentation. */
    const present = () => {
      const theme = source?.defaultTheme ? resolveBuiltInTheme(source.defaultTheme) : null;
      if (!source || !theme || record?.status !== "active") {
        presentation = null;
        return;
      }
      const body = {
        environmentId: source.environmentId,
        grant: { id: record.grant.id, expiresAt: record.grant.expiresAt },
        resolverPin: T3_RESOLVER_PIN,
        theme: { id: theme.id, name: theme.name },
        modes: presentThemeModes(theme),
      };
      presentation = { revision: revisionOf(body), ...body };
    };

    const closeWatch = () => {
      const open = watch;
      watch = null;
      open?.stream.close();
    };
    /** The previous source's colors must never outlive it. */
    const invalidate = () => {
      closeWatch();
      source = null;
      presentation = null;
    };

    const apply = (open: Watch, event: AppearanceEvent) => {
      if (event.type === "snapshot") {
        if (event.environmentId !== open.environmentId) {
          refusedEnvironment = open.environmentId;
          invalidate();
          problem = MISMATCH;
          return;
        }
        source = {
          environmentId: event.environmentId,
          defaultTheme: event.defaultTheme,
          themes: source?.themes ?? [],
        };
        problem = null;
      } else if (!source) return;
      else if (event.type === "default") source = { ...source, defaultTheme: event.defaultTheme };
      else source = { ...source, themes: event.themes };
      present();
    };

    /** T3 refusing a grant about to expire is its expiry, even with a little clock skew. */
    const refusalReason = Effect.map(Clock.currentTimeMillis, (now) =>
      record && now >= Date.parse(record.grant.expiresAt) - EXPIRY_SKEW_MS
        ? ("expired" as const)
        : ("revoked" as const),
    );

    const endGrant = (target: string, reason: "expired" | "revoked") =>
      Effect.gen(function* () {
        const ended = yield* Effect.tryPromise(() =>
          t3.endAppearanceGrant({ endpoint: target }, reason),
        ).pipe(Effect.orElseSucceed(() => null));
        record = ended ?? (record && { status: "ended", grant: record.grant, reason });
        invalidate();
        problem = null;
      });

    /** Reads every event of one subscription; a closed subscription triggers a grant check. */
    const follow = (open: Watch): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Effect.tryPromise(() => open.stream.next()).pipe(
            Effect.orElseSucceed(() => null),
          );
          const done = yield* serial(
            Effect.gen(function* () {
              if (watch !== open) return true;
              if (event === null) {
                watch = null;
                yield* closed;
                return true;
              }
              apply(open, event);
              yield* publish;
              return watch !== open;
            }),
          );
          if (done) return;
        }
      });

    const install = (stream: AppearanceStream, environmentId: string) =>
      Effect.gen(function* () {
        const open = { stream, environmentId };
        watch = open;
        yield* Effect.forkIn(follow(open), scope);
        return open;
      });

    /** The saved endpoint and the environment its authorization context was bound to. */
    const savedBinding = Effect.map(getConnection(), (connection) => {
      const saved = connection.ok ? connection.value : null;
      return {
        endpoint: saved?.endpoint ?? null,
        environment: saved?.authorizationContext?.environmentId ?? null,
      };
    });

    const readGrant = (target: string) =>
      Effect.tryPromise(() => t3.readAppearanceGrant({ endpoint: target })).pipe(
        Effect.orElseSucceed(() => null),
      );

    /** A different saved endpoint is a different source with its own stored grant. */
    const adoptEndpoint = (saved: string | null) =>
      Effect.gen(function* () {
        if (saved === endpoint) return;
        invalidate();
        problem = null;
        refusedEnvironment = null;
        endpoint = saved;
        record = saved ? yield* readGrant(saved) : null;
      });

    /**
     * Asks T3 whether the active grant still authenticates: a revocation from another T3
     * process leaves the socket open, so this runs on every close and every periodic pass.
     */
    const verifyGrant = (target: string) =>
      Effect.gen(function* () {
        const checked = yield* Effect.tryPromise(() =>
          t3.checkAppearanceGrant({ endpoint: target }),
        ).pipe(Effect.option);
        if (checked._tag === "Some" && checked.value === "active") return true;
        if (checked._tag === "Some") yield* endGrant(target, yield* refusalReason);
        // With a subscription still open, a failed check alone proves no outage.
        else if (!watch) problem = outage(presentation !== null);
        return false;
      });

    const subscribe = (target: string, environment: string) =>
      Effect.gen(function* () {
        const opened = yield* Effect.tryPromise(() =>
          t3.watchAppearance({ endpoint: target }),
        ).pipe(Effect.option);
        if (opened._tag === "None") problem = outage(presentation !== null);
        else yield* install(opened.value, environment);
      });

    /** Follows the active grant for the connection's environment, or explains why not. */
    const followGrant = (target: string, expiresAt: string, environment: string | null) =>
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) >= Date.parse(expiresAt))
          return yield* endGrant(target, "expired");
        if (!environment) {
          invalidate();
          problem = UNVERIFIABLE;
          return;
        }
        // A subscription or colors of another environment never outlive the replacement.
        if (watch && watch.environmentId !== environment) invalidate();
        if (presentation && presentation.environmentId !== environment) presentation = null;
        if (refusedEnvironment === environment) return;
        refusedEnvironment = null;
        if ((yield* verifyGrant(target)) && !watch) yield* subscribe(target, environment);
      });

    /**
     * A closed socket may be T3 ending the grant, so the grant is checked at once. The
     * subscription reopens on the next periodic pass, never in a loop with T3's closes.
     */
    const closed = Effect.gen(function* () {
      const target = endpoint;
      const active = record?.status === "active" ? record : null;
      if (target && active) {
        if ((yield* Clock.currentTimeMillis) >= Date.parse(active.grant.expiresAt))
          yield* endGrant(target, "expired");
        // What T3 last reported is stale until a new snapshot; its colors stay meanwhile.
        else if (yield* verifyGrant(target)) source = null;
      }
      yield* publish;
    });

    /** Brings the subscription in line with the saved endpoint, its environment and the grant. */
    const reconcile: Effect.Effect<void> = Effect.gen(function* () {
      const saved = yield* savedBinding;
      binding = JSON.stringify(saved);
      yield* adoptEndpoint(saved.endpoint);
      const target = endpoint;
      const active = record?.status === "active" ? record : null;
      if (target && active) yield* followGrant(target, active.grant.expiresAt, saved.environment);
      else {
        invalidate();
        problem = null;
      }
      yield* publish;
    });

    /** Connection checks publish often; only a changed endpoint or environment matters here. */
    const connectionChanged = Effect.gen(function* () {
      if (JSON.stringify(yield* savedBinding) !== binding) yield* reconcile;
    });

    /**
     * The first status comes from local state alone, before T3 is asked anything: the stored
     * grant and, while it is active, unexpired and bound to the connection's environment, the
     * snapshot the previous process stored. Only this step adopts a stored snapshot, so no
     * later source change can bring old colors back; the grant check and T3's first
     * configuration snapshot that follow end or replace them.
     */
    yield* serial(
      Effect.gen(function* () {
        const saved = yield* savedBinding;
        yield* adoptEndpoint(saved.endpoint);
        const active = record?.status === "active" ? record.grant : null;
        if (
          endpoint &&
          active &&
          saved.environment &&
          (yield* Clock.currentTimeMillis) < Date.parse(active.expiresAt)
        )
          presentation = yield* restore(endpoint, saved.environment, active);
        yield* publish;
      }),
    );

    const connectionHint = yield* changes.watch({ kind: "connection" });
    yield* Effect.forkIn(
      Effect.forever(
        Effect.gen(function* () {
          yield* connectionHint.await;
          connectionHint.closeUnsafe();
          yield* serial(connectionChanged);
        }),
      ),
      scope,
    );
    // Startup never waits for T3: appearance is optional and independent of readiness.
    yield* Effect.forkIn(serial(reconcile), scope);
    const stopWorker = yield* periodicWorker(intervalMs, serial(reconcile), serial(Effect.void));
    yield* Effect.addFinalizer(() =>
      stopWorker.pipe(Effect.andThen(serial(Effect.sync(closeWatch)))),
    );

    const pair = (input: unknown) =>
      Effect.gen(function* () {
        const connection = yield* getConnection();
        const saved = connection.ok ? connection.value : null;
        if (!saved?.endpoint)
          return failure("validation", "Save the T3 endpoint on this host before pairing.");
        const environment = saved.authorizationContext?.environmentId;
        if (!environment)
          return failure(
            "validation",
            "Authorize the T3 connection on this host first, so Factory can confirm the paired environment.",
          );
        const code = pairingCode(input, saved.endpoint);
        if (!code.ok) return code;
        const target = saved.endpoint;
        const exchanged = yield* Effect.tryPromise({
          try: () => t3.pairAppearance({ endpoint: target }, code.value),
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onSuccess: (grant) => ({ ok: true as const, grant }),
            onFailure: (error) => ({
              ok: false as const,
              refusal:
                error instanceof AppearancePairingRejected
                  ? invalidPairing(pairingRefusals[error.reason])
                  : failure("conflict", "T3 could not be reached to pair. Check T3 and try again."),
            }),
          }),
        );
        // A refused exchange leaves the current grant and colors as they are.
        if (!exchanged.ok) return exchanged.refusal;
        invalidate();
        endpoint = target;
        record = { status: "active", grant: exchanged.grant };
        const refuse = (message: string) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => t3.forgetAppearanceGrant({ endpoint: target })).pipe(
              Effect.ignore,
            );
            record = null;
            problem = null;
            yield* publish;
            return failure("conflict", message);
          });
        const stream = yield* Effect.tryPromise(() =>
          t3.watchAppearance({ endpoint: target }),
        ).pipe(Effect.option);
        if (stream._tag === "None")
          return yield* refuse(
            "T3 could not be reached to confirm the paired environment, so Factory discarded the grant. Pair again.",
          );
        const first = yield* Effect.tryPromise(() => stream.value.next()).pipe(
          Effect.timeoutOption(FIRST_SNAPSHOT),
          Effect.orElseSucceed(() => undefined),
        );
        const snapshot = first?._tag === "Some" ? first.value : null;
        if (snapshot?.type !== "snapshot") {
          stream.value.close();
          return yield* refuse(
            "T3 did not report its environment in time, so Factory discarded the grant. Pair again.",
          );
        }
        if (snapshot.environmentId !== environment) {
          stream.value.close();
          return yield* refuse(
            "The paired T3 environment is not the one the T3 connection uses, so Factory discarded the grant. Pair with a code from the connected T3.",
          );
        }
        problem = null;
        refusedEnvironment = null;
        apply(yield* install(stream.value, environment), snapshot);
        yield* publish;
        return { ok: true as const, value: status };
      });

    const disconnect = () =>
      Effect.gen(function* () {
        const target = endpoint;
        if (target) yield* Effect.tryPromise(() => t3.forgetAppearanceGrant({ endpoint: target }));
        record = null;
        problem = null;
        invalidate();
        yield* publish;
        return { ok: true as const, value: status };
      });

    return {
      getAppearance: () => Effect.sync(() => status),
      pairAppearance: (input: unknown) => serial(pair(input)),
      disconnectAppearance: () => serial(disconnect()),
    };
  });

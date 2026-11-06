import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  ClientAccessGrant,
  ClientAccessState,
  ClientAccessStatus,
  ClientKind,
  FactoryClient,
  HostLifecycle,
  Result,
} from "@t3-factory/contracts";
import { validateClientAccessRequest } from "@t3-factory/domain-validation";
import { failure } from "./result.ts";
import { now } from "./time.ts";

/** Unanswered requests expire so a reachable address cannot accumulate approvals. */
const PENDING_LIFETIME_MS = 15 * 60_000;
const MAX_PENDING = 10;
/** Bound last-seen writes; authorization itself is checked on every request. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

interface GrantRow {
  readonly id: string;
  readonly label: string;
  readonly kind: ClientKind;
  readonly status: ClientAccessStatus;
  readonly secret_hash: string;
  readonly verification_code: string;
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly last_seen_at: string | null;
}

const toClient = (row: GrantRow): FactoryClient => ({
  id: row.id,
  label: row.label,
  kind: row.kind,
  status: row.status,
  verificationCode: row.verification_code,
  requestedAt: row.requested_at,
  decidedAt: row.decided_at,
  lastSeenAt: row.last_seen_at,
});

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** `<client id>.<secret>`; the id selects the row, the secret proves possession. */
function parseCredential(credential: string): { id: string; secret: string } | undefined {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
      credential,
    );
  return match ? { id: match[1]!, secret: match[2]! } : undefined;
}

function secretMatches(row: GrantRow, secret: string): boolean {
  const expected = Buffer.from(row.secret_hash, "hex");
  const actual = Buffer.from(hashSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const verificationCode = () => {
  const digits = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
};

const unauthorizedMessage: Record<ClientAccessStatus | "none", string> = {
  none: "This client is not approved. Request access and approve it on the Factory host.",
  pending: "Waiting for approval on the Factory host.",
  denied: "The Factory host denied this client. Request access again if this was a mistake.",
  revoked: "The Factory host revoked this client's access.",
  approved: "",
};

/** Client approval is Factory's own trust boundary, separate from T3 OAuth and report validation. */
export const makeClientAccess = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const expirePending = Effect.gen(function* () {
    const cutoff = new Date(Date.parse(yield* now) - PENDING_LIFETIME_MS).toISOString();
    yield* sql`DELETE FROM client_grants WHERE status = 'pending' AND requested_at < ${cutoff}`;
  });

  const find = (credential: string) =>
    Effect.gen(function* () {
      const parsed = parseCredential(credential);
      if (!parsed) return undefined;
      yield* expirePending;
      const [row] = yield* sql<GrantRow>`SELECT * FROM client_grants WHERE id = ${parsed.id}`;
      return row && secretMatches(row, parsed.secret) ? row : undefined;
    });

  const decide = (
    id: string,
    from: readonly ClientAccessStatus[],
    to: ClientAccessStatus,
    rejected: string,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* expirePending;
        const [row] = yield* sql<GrantRow>`SELECT * FROM client_grants WHERE id = ${id}`;
        if (!row) return failure("not_found", "This client request no longer exists.");
        if (row.status === to) return { ok: true as const, value: toClient(row) };
        if (!from.includes(row.status)) return failure("conflict", rejected);
        const [updated] = yield* sql<GrantRow>`
          UPDATE client_grants SET status = ${to}, decided_at = ${yield* now}
          WHERE id = ${id} RETURNING *`;
        return { ok: true as const, value: toClient(updated!) };
      }),
    );

  return {
    requestClientAccess: (input: unknown) =>
      sql.withTransaction(
        Effect.gen(function* (): Generator<
          Effect.Effect<unknown, unknown>,
          Result<ClientAccessGrant>,
          never
        > {
          const parsed = validateClientAccessRequest(input);
          if (!parsed.ok) return parsed;
          yield* expirePending;
          const [pending] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM client_grants WHERE status = 'pending'`;
          if ((pending?.count ?? 0) >= MAX_PENDING)
            return failure(
              "conflict",
              "Too many clients are waiting for approval. Approve or deny them on the Factory host first.",
            );
          // Part of the credential, so it comes from cryptographic randomness like the secret.
          const id = randomUUID();
          const secret = randomBytes(32).toString("base64url");
          const [row] = yield* sql<GrantRow>`
            INSERT INTO client_grants
              (id, label, kind, status, secret_hash, verification_code, requested_at)
            VALUES (${id}, ${parsed.value.label}, ${parsed.value.kind}, 'pending',
              ${hashSecret(secret)}, ${verificationCode()}, ${yield* now})
            RETURNING *`;
          return { ok: true, value: { client: toClient(row!), credential: `${id}.${secret}` } };
        }),
      ),
    getClientAccess: (credential: string) =>
      Effect.gen(function* (): Generator<
        Effect.Effect<unknown, unknown>,
        Result<ClientAccessState>,
        never
      > {
        const row = yield* find(credential);
        return {
          ok: true,
          value: row ? { status: row.status, client: toClient(row) } : { status: "none" },
        };
      }),
    authenticateClient: (credential: string) =>
      Effect.gen(function* (): Generator<
        Effect.Effect<unknown, unknown>,
        Result<FactoryClient>,
        never
      > {
        const row = yield* find(credential);
        if (row?.status !== "approved")
          return failure("unauthorized", unauthorizedMessage[row?.status ?? "none"]);
        const seen = yield* now;
        if (
          row.last_seen_at === null ||
          Date.parse(seen) - Date.parse(row.last_seen_at) >= LAST_SEEN_RESOLUTION_MS
        ) {
          // Revocation wins over a concurrent last-seen write: only approved rows are touched.
          yield* sql`UPDATE client_grants SET last_seen_at = ${seen}
            WHERE id = ${row.id} AND status = 'approved'`;
          return { ok: true, value: { ...toClient(row), lastSeenAt: seen } };
        }
        return { ok: true, value: toClient(row) };
      }),
    listClients: () =>
      Effect.gen(function* (): Generator<
        Effect.Effect<unknown, unknown>,
        Result<readonly FactoryClient[]>,
        never
      > {
        yield* expirePending;
        const rows = yield* sql<GrantRow>`SELECT * FROM client_grants
          ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
            requested_at DESC`;
        return { ok: true, value: rows.map(toClient) };
      }),
    approveClient: (id: string) =>
      decide(
        id,
        ["pending"],
        "approved",
        "Only a waiting request can be approved. Ask the client to request access again.",
      ),
    denyClient: (id: string) =>
      decide(id, ["pending"], "denied", "Only a waiting request can be denied."),
    revokeClient: (id: string) =>
      decide(
        id,
        ["approved", "pending"],
        "revoked",
        "This client was denied and has no access to revoke.",
      ),
    getHostLifecycle: () =>
      Effect.gen(function* (): Generator<
        Effect.Effect<unknown, unknown>,
        Result<HostLifecycle>,
        never
      > {
        const [open] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM runs WHERE closed_at IS NULL`;
        return { ok: true, value: { openRunCount: open?.count ?? 0 } };
      }),
  };
});

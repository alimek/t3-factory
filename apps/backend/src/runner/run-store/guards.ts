import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** The guard facts a transition declares. Every named fact must hold inside its transaction. */
export type GuardFacts = {
  /** This backend still owns the database. */
  readonly owner?: true;
  readonly notArchived?: true;
  /** The authorization context the Run was accepted under, which must still be the live one. */
  readonly liveContext?: string;
  readonly gateOpen?: true;
  /** The generation the caller's read was made at; the Run must not have moved since. */
  readonly generation?: number;
};

type Held = {
  archived_at: string | null;
  gate_open: number;
  generation: number;
  token: string | null;
  live_context: string | null;
};

/** Whether the Run exists and every declared guard fact holds. */
export function guardsHold(
  sql: SqlClient.SqlClient,
  ownerToken: string,
  runId: string,
  facts: GuardFacts,
) {
  const checks: Record<keyof GuardFacts, (held: Held) => boolean> = {
    owner: (held) => held.token === ownerToken,
    notArchived: (held) => !held.archived_at,
    liveContext: (held) => held.live_context === facts.liveContext,
    gateOpen: (held) => Boolean(held.gate_open),
    generation: (held) => held.generation === facts.generation,
  };
  const declared = (Object.keys(checks) as (keyof GuardFacts)[]).filter(
    (fact) => facts[fact] !== undefined,
  );
  return Effect.map(
    sql<Held>`SELECT r.archived_at,r.gate_open,r.generation,o.token,c.context_id AS live_context FROM runs r
      LEFT JOIN runner_owner o ON o.singleton=1 LEFT JOIN t3_connection c ON c.singleton=1 WHERE r.id=${runId}`,
    ([held]) => !!held && declared.every((fact) => checks[fact](held)),
  );
}

/** A transition that turns a released Handoff into work: owner, not Archived, live authorization
 * context, open gate and the generation the caller read the release at all hold, and the Handoff
 * is still pending. */
export function pendingHandoffHolds(
  sql: SqlClient.SqlClient,
  ownerToken: string,
  current: { readonly id: string; readonly context_id: string; readonly generation: number },
  handoffId: string,
) {
  return Effect.gen(function* () {
    const held = yield* guardsHold(sql, ownerToken, current.id, {
      owner: true,
      notArchived: true,
      liveContext: current.context_id,
      gateOpen: true,
      generation: current.generation,
    });
    if (!held) return false;
    const pending =
      yield* sql`SELECT id FROM operation_intents WHERE id=${handoffId} AND kind='handoff' AND state='pending'`;
    return pending.length > 0;
  });
}

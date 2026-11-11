import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import type { BlockRow } from "../runner-types.ts";
import type { BlockState } from "./states.ts";

/** Any holder of a Block id can address that Block; Factory MCP is host-local for one user. */
export function resolveBlock(sql: SqlClient.SqlClient, publicId: string) {
  return Effect.map(
    sql<BlockRow>`SELECT * FROM run_blocks WHERE public_id=${publicId}`,
    (rows) => rows[0],
  );
}

/** Which Blocks of one Run a state write reaches: one Block, or every Block of the Run; with
 * `threadless`, only while the Block has no worker thread. */
type BlockTarget = {
  readonly runId: string;
  readonly blockId?: string;
  readonly threadless?: true;
};

/** The state written: one state, or one decided per Block from what it holds now. */
type StateWrite =
  | BlockState
  /** Keeps a state listed in `keep`, otherwise writes `otherwise`. */
  | { readonly keep: readonly BlockState[]; readonly otherwise: BlockState }
  /** Writes `whileArrivalPending` while a Human occurrence or Wait arrival is pending on the
   * Block. */
  | { readonly whileArrivalPending: BlockState; readonly otherwise: BlockState };

/** The Block columns a state write may set beside the state. */
type BlockColumns = {
  readonly [K in Exclude<keyof BlockRow, "run_id" | "block_id" | "public_id" | "name" | "state">]?:
    | BlockRow[K]
    | Fragment;
};

function stateValue(sql: SqlClient.SqlClient, state: StateWrite) {
  if (typeof state === "string") return sql`${state}`;
  if ("keep" in state)
    return sql`CASE WHEN state IN ${sql.in(state.keep)} THEN state ELSE ${state.otherwise} END`;
  return sql`CASE WHEN EXISTS(SELECT 1 FROM human_occurrences h WHERE h.run_id=run_blocks.run_id AND h.block_id=run_blocks.block_id AND h.state='pending') OR EXISTS(SELECT 1 FROM wait_arrivals w WHERE w.run_id=run_blocks.run_id AND w.block_id=run_blocks.block_id AND w.state='pending') THEN ${state.whileArrivalPending} ELSE ${state.otherwise} END`;
}

/** The only writer of Block state: sets `state` and `columns` on the Blocks `target` reaches. */
export function writeBlockState(
  sql: SqlClient.SqlClient,
  target: BlockTarget,
  state: StateWrite,
  columns: BlockColumns = {},
) {
  const assignments = [
    sql`state=${stateValue(sql, state)}`,
    ...Object.entries(columns).map(([column, value]) => sql`${sql.literal(column)}=${value}`),
  ];
  const conditions = [
    sql`run_id=${target.runId}`,
    ...(target.blockId === undefined ? [] : [sql`block_id=${target.blockId}`]),
    ...(target.threadless ? [sql`thread_id IS NULL`] : []),
  ];
  return sql`UPDATE run_blocks SET ${sql.csv(assignments)} WHERE ${sql.and(conditions)}`;
}

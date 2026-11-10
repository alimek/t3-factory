import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { BlockRow } from "../runner-types.ts";

/** Any holder of a Block id can address that Block; Factory MCP is host-local for one user. */
export function resolveBlock(sql: SqlClient.SqlClient, publicId: string) {
  return Effect.map(
    sql<BlockRow>`SELECT * FROM run_blocks WHERE public_id=${publicId}`,
    (rows) => rows[0],
  );
}

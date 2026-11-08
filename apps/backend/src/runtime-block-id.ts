import type * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import type { BlockRow } from "./runner-types.ts";
import type { RuntimeReply } from "./runtime-types.ts";

/** The Block id from a Factory MCP call; `fields` are the other arguments the tool accepts. */
export function blockIdArgument(input: unknown, fields: readonly string[]): string | RuntimeReply {
  const args = (input as { arguments?: unknown } | null)?.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args)) return { code: "INVALID_ARGUMENT" };
  const values = args as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "blockId" && !fields.includes(key)))
    return { code: "INVALID_ARGUMENT" };
  return typeof values.blockId === "string" && values.blockId
    ? values.blockId
    : { code: "BLOCK_ID_REQUIRED" };
}

/** Any holder of a Block id can address that Block; Factory MCP is host-local for one user. */
export function resolveBlock(sql: SqlClient.SqlClient, publicId: string) {
  return Effect.map(
    sql<BlockRow>`SELECT * FROM run_blocks WHERE public_id=${publicId}`,
    (rows) => rows[0],
  );
}

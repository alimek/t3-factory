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

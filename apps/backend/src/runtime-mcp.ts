import {
  createMcpHandler,
  Server,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import type { RuntimeReply } from "./runtime-types.ts";

const refProperty = {
  type: "string",
  description:
    "Factory tool ref from the thread message, when one is present. Not a Run or Block id.",
} as const;

const tools: Tool[] = [
  {
    name: "factory_update_block",
    description:
      "Move the caller's Block to waiting or finished. waiting needs a nonempty message and no exit. finished uses one configured exit and is sent once per visit. The same transition and content returns the original acknowledgement. A different one from the same state conflicts; choose from the reply's allowedTransitions and allowedExits. Caller identity comes from harness metadata.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", enum: ["waiting", "finished"] },
        exit: {
          type: "string",
          description: "Exact configured exit name or ID from this Block's captured Flow.",
        },
        message: { type: "string" },
        ref: refProperty,
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_block",
    description:
      "Read the caller's Block. BINDING_PENDING grants nothing; wait retryAfterMs and call again. Subagents are not callers.",
    inputSchema: {
      type: "object",
      properties: { ref: refProperty },
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_run",
    description: "Read the caller's Run. This grants no routing authority.",
    inputSchema: {
      type: "object",
      properties: { ref: refProperty },
      additionalProperties: false,
    },
  },
];

const SUCCESS_CODES = ["ACCEPTED", "CONTEXT", "BLOCK", "RUN"];
const operations = {
  factory_update_block: "submit",
  factory_get_block: "block",
  factory_get_run: "run",
} as const;

/** Runtime operations behind the tools; each receives the call as the harness sent it. */
export interface RuntimeTools {
  submit(input: unknown): Promise<RuntimeReply>;
  block(input: unknown): Promise<RuntimeReply>;
  run(input: unknown): Promise<RuntimeReply>;
}

async function callTool(
  runtime: RuntimeTools,
  name: keyof typeof operations,
  args: unknown,
  metadata: unknown,
): Promise<CallToolResult> {
  try {
    const body = await runtime[operations[name]]({
      arguments: args ?? (name === "factory_update_block" ? undefined : {}),
      metadata: metadata ?? {},
    });
    return {
      isError: !SUCCESS_CODES.includes(body.code),
      content: [{ type: "text", text: JSON.stringify(body) }],
    };
  } catch {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "RUNTIME_UNAVAILABLE: no success asserted. Recheck the owning Factory backend.",
        },
      ],
    };
  }
}

/**
 * Stateless Streamable HTTP MCP server for harness reporting. It holds no identity:
 * the backend correlates each call through its native call metadata.
 */
export function runtimeMcpHandler(runtime: RuntimeTools): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: "factory-runtime", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/list", () => ({ tools }));
      server.setRequestHandler("tools/call", async (request) => {
        const { name, arguments: args, _meta } = request.params;
        if (!Object.hasOwn(operations, name))
          return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}.` }] };
        return callTool(runtime, name as keyof typeof operations, args, _meta);
      });
      return server;
    },
    { maxRequestBodySize: 131_072 },
  );
  return (request) => handler.fetch(request);
}

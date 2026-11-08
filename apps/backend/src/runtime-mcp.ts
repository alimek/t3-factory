import {
  createMcpHandler,
  Server,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import type { RuntimeReply } from "./runtime-types.ts";

const blockIdProperty = {
  type: "string",
  description:
    "Your Block id from the Factory Block id line of this thread's Factory message. Only the Block's own worker passes it; subagents do not call Factory tools.",
} as const;

const tools: Tool[] = [
  {
    name: "factory_update_block",
    description:
      "Report your Block's state. waiting needs a nonempty message for the user and no exit; report it from any turn while you still need a reply. finished needs one configured exit and a message for the next Block (required when the exit asks for feedback); the newest finished report is the visit's result, so a later one replaces it (after hand-off the same exit only updates the result, and a different exit also starts that exit's next Blocks); never report finished while CI, review, delegated or background work is still pending. Repeating the same report returns the same acknowledgement.",
    inputSchema: {
      type: "object",
      properties: {
        blockId: blockIdProperty,
        to: { type: "string", enum: ["waiting", "finished"] },
        exit: {
          type: "string",
          description: "Exact configured exit name or ID from this Block's captured Flow.",
        },
        message: { type: "string" },
      },
      required: ["blockId", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_block",
    description:
      "Read your Block's current visit: state, why it was activated, its inputs, exits and allowed reports.",
    inputSchema: {
      type: "object",
      properties: { blockId: blockIdProperty },
      required: ["blockId"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_run",
    description: "Read the Run your Block belongs to, with each Block's state and latest result.",
    inputSchema: {
      type: "object",
      properties: { blockId: blockIdProperty },
      required: ["blockId"],
      additionalProperties: false,
    },
  },
];

const SUCCESS_CODES = ["ACCEPTED", "BLOCK", "RUN"];
const operations = {
  factory_update_block: "submit",
  factory_get_block: "block",
  factory_get_run: "run",
} as const;

/** Runtime operations behind the tools; each receives the call's arguments. */
export interface RuntimeTools {
  submit(input: unknown): Promise<RuntimeReply>;
  block(input: unknown): Promise<RuntimeReply>;
  run(input: unknown): Promise<RuntimeReply>;
}

async function callTool(
  runtime: RuntimeTools,
  name: keyof typeof operations,
  args: unknown,
): Promise<CallToolResult> {
  try {
    const body = await runtime[operations[name]]({ arguments: args });
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
 * Stateless Streamable HTTP MCP server for harness reporting. Calls name their Block
 * by Block id; the server holds no identity of its own.
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
        const { name, arguments: args } = request.params;
        if (!Object.hasOwn(operations, name))
          return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}.` }] };
        return callTool(runtime, name as keyof typeof operations, args);
      });
      return server;
    },
    { maxRequestBodySize: 131_072 },
  );
  return (request) => handler.fetch(request);
}

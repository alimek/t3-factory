import {
  createMcpHandler,
  Server,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import { authoringTools, callAuthoringTool, type AuthoringOperations } from "./authoring-tools.ts";
import { flowDocumentBody } from "./http-support.ts";
import { SUCCESS_CODES, type RuntimeReply } from "./runtime-types.ts";

const blockIdProperty = {
  type: "string",
  description:
    "Your Block id from the Factory Block id line of this thread's Factory message. Only the Block's own worker passes it; subagents do not call Factory tools.",
} as const;

const tools: Tool[] = [
  {
    name: "factory_update_block",
    description:
      "Report your Block's state. working needs a nonempty message saying what you are doing or waiting on and no exit; report it when you start this visit's work, and again only to replace that message or when you reopen the task. It stays current across later turns of the visit, so asking the user questions and reading their replies need no report: end a questioning turn with the questions as your final message. finished needs one of the Block's exits and a message for the next Block (required when the exit requires a message); report it only when the task is complete, never while questions, CI, review, delegated or background work are still open. The newest finished report is the visit's result, so a later one replaces it (after hand-off the same exit only updates the result, and a different exit also starts that exit's next Blocks). Your latest report is the Block's current report. Repeating the same report returns the same acknowledgement.",
    inputSchema: {
      type: "object",
      properties: {
        blockId: blockIdProperty,
        to: { type: "string", enum: ["working", "finished"] },
        exit: {
          type: "string",
          description:
            "finished only: exact exit name or ID from the exits factory_get_block lists.",
        },
        message: {
          type: "string",
          description:
            "working: what you are doing or waiting on. finished: the result for the next Block.",
        },
      },
      required: ["blockId", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_block",
    description:
      "Read your Block's current visit: state, why it was activated, its inputs, exits {id, name, description, messageRequired} and allowed reports. inputs.images is an ordered manifest {imageId, ordinal, name, mimeType, sizeBytes}; ordinal N matches [Image N: name] in the Run input. Fetch an image with factory_get_run_image; this read carries no image bytes.",
    inputSchema: {
      type: "object",
      properties: { blockId: blockIdProperty },
      required: ["blockId"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_run_image",
    description:
      "Return one original image of the Run's initial prompt as image content. Fetch only images relevant to your task. This read is read-only and safe to repeat.",
    inputSchema: {
      type: "object",
      properties: {
        blockId: blockIdProperty,
        imageId: {
          type: "string",
          description: "An imageId from factory_get_block inputs.images.",
        },
      },
      required: ["blockId", "imageId"],
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

const operations = {
  factory_update_block: "submit",
  factory_get_block: "block",
  factory_get_run: "run",
  factory_get_run_image: "image",
} as const;

/** Runtime operations behind the tools; each receives the call's arguments. */
export interface RuntimeTools {
  submit(input: unknown): Promise<RuntimeReply>;
  block(input: unknown): Promise<RuntimeReply>;
  run(input: unknown): Promise<RuntimeReply>;
  image(input: unknown): Promise<RuntimeReply>;
}

async function callTool(
  runtime: RuntimeTools,
  name: keyof typeof operations,
  args: unknown,
): Promise<CallToolResult> {
  try {
    const body = await runtime[operations[name]]({ arguments: args });
    const { data, ...reply } = body;
    const text = { type: "text" as const, text: JSON.stringify(reply) };
    if (reply.code === "IMAGE") {
      if (!data || !reply.image) throw new Error("Image reply is missing content");
      return {
        isError: false,
        content: [
          text,
          {
            type: "image",
            data: Buffer.from(data).toString("base64"),
            mimeType: reply.image.mimeType,
          },
        ],
      };
    }
    return {
      isError: !SUCCESS_CODES.includes(reply.code),
      content: [text],
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
 * Stateless Streamable HTTP MCP server for harness reporting and definition authoring. Reporting
 * calls name their Block by Block id; authoring calls need none. The server holds no identity.
 */
export function runtimeMcpHandler(
  runtime: RuntimeTools,
  definitions: AuthoringOperations,
): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: "factory-runtime", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/list", () => ({ tools: [...tools, ...authoringTools] }));
      server.setRequestHandler("tools/call", async (request) => {
        const { name, arguments: args } = request.params;
        if (Object.hasOwn(operations, name))
          return callTool(runtime, name as keyof typeof operations, args);
        return (
          (await callAuthoringTool(definitions, name, args)) ?? {
            isError: true,
            content: [{ type: "text", text: `Unknown tool ${name}.` }],
          }
        );
      });
      return server;
    },
    // A Flow save carries a whole graph, as Studio's Flow document body does.
    { maxRequestBodySize: flowDocumentBody.bytes },
  );
  return (request) => handler.fetch(request);
}

/** Local harness transport only: no OAuth, SQL, scheduling, or prompt identity. */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const endpoint = process.argv[2];
const tools = [
  {
    name: "factory_update_block",
    description:
      "Move the caller's Block to waiting or finished. waiting needs a nonempty message and no exit. finished uses one configured exit. The same transition and content returns the original acknowledgement. A different one from the same state conflicts. Caller identity comes from harness metadata.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", enum: ["waiting", "finished"] },
        exit: {
          type: "string",
          description: "Exact configured exit name or ID from this Block's captured Flow.",
        },
        message: { type: "string" },
        ref: {
          type: "string",
          description:
            "Factory tool ref from the thread message, when one is present. Not a Run or Block id.",
        },
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
      properties: {
        ref: {
          type: "string",
          description:
            "Factory tool ref from the thread message, when one is present. Not a Run or Block id.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "factory_get_run",
    description: "Read the caller's Run. This grants no routing authority.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description:
            "Factory tool ref from the thread message, when one is present. Not a Run or Block id.",
        },
      },
      additionalProperties: false,
    },
  },
];
const toolPaths = {
  factory_update_block: "/api/runtime/report",
  factory_get_block: "/api/runtime/block",
  factory_get_run: "/api/runtime/run",
};
for await (const line of createInterface({ input: process.stdin })) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    continue;
  }
  if (m.id === undefined) continue;
  try {
    let result;
    if (m.method === "initialize")
      result = {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "factory-runtime", version: "0.1.0" },
      };
    else if (m.method === "tools/list")
      result = {
        tools,
      };
    else if (m.method === "ping") result = {};
    else if (m.method === "tools/call" && Object.hasOwn(toolPaths, m.params?.name)) {
      const toolPath = toolPaths[/** @type {keyof typeof toolPaths} */ (m.params.name)];
      const backend =
        endpoint === "--connection-file"
          ? JSON.parse(await readFile(process.argv[3] ?? "", "utf8")).endpoint
          : endpoint;
      if (!backend) throw Error("Backend unavailable");
      const response = await fetch(new URL(toolPath, backend), {
        method: "POST",
        headers: { "content-type": "application/json", "X-Factory-Request": "1" },
        body: JSON.stringify({
          arguments:
            m.params.arguments ?? (m.params.name === "factory_update_block" ? undefined : {}),
          metadata: m.params._meta ?? {},
          inheritedThreadId: process.env.T3CODE_THREAD_ID,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error("Backend unavailable");
      const body = /** @type {{ code: string }} */ (await response.json());
      result = {
        isError: !["ACCEPTED", "CONTEXT", "BLOCK", "RUN"].includes(body.code),
        content: [{ type: "text", text: JSON.stringify(body) }],
      };
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "RUNTIME_UNAVAILABLE: no success asserted. Recheck the owning Factory backend.",
            },
          ],
        },
      }) + "\n",
    );
  }
}

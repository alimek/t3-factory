/** Local harness transport only: no OAuth, SQL, scheduling, or prompt identity. */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const endpoint = process.argv[2];
const tool = {
  name: "factory_report",
  description:
    "Report a result with a stable retry key, optional configured exit and feedback. The first finished result is immutable. Acceptance is durable, not engine completion. Waiting is non-final and needs a message and no exit. Caller identity comes from harness metadata.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      status: { type: "string", enum: ["waiting", "finished"] },
      exit: {
        type: "string",
        description: "Exact configured exit name or ID from this Block's captured Flow.",
      },
      message: { type: "string" },
    },
    required: ["key", "status"],
    additionalProperties: false,
  },
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
        tools: [
          tool,
          {
            name: "factory_context",
            description:
              "Read caller-scoped Factory context. The Run conversation reads current Run state; a Block worker reads its own activation. BINDING_PENDING grants nothing; end the turn without polling or replacement.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      };
    else if (m.method === "ping") result = {};
    else if (
      m.method === "tools/call" &&
      ["factory_report", "factory_context"].includes(m.params?.name)
    ) {
      const backend =
        endpoint === "--connection-file"
          ? JSON.parse(await readFile(process.argv[3] ?? "", "utf8")).endpoint
          : endpoint;
      if (!backend) throw Error("Backend unavailable");
      const response = await fetch(
        new URL(
          m.params.name === "factory_context" ? "/api/runtime/context" : "/api/runtime/report",
          backend,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json", "X-Factory-Request": "1" },
          body: JSON.stringify({
            arguments: m.params.arguments,
            metadata: m.params._meta ?? {},
            inheritedThreadId: process.env.T3CODE_THREAD_ID,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw Error("Backend unavailable");
      const body = /** @type {{ code: string }} */ (await response.json());
      result = {
        isError: !["ACCEPTED", "CONTEXT"].includes(body.code),
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

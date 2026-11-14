import type { TestContext } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Factory } from "../../src/index.ts";
import { runtimeMcpHandler } from "../../src/runtime-mcp.ts";
import { openFactoryWithApprovedT3 } from "./domain-setup.ts";

/**
 * A worker's MCP client on the Factory MCP handler of an open backend, over Streamable HTTP
 * without a listening socket. With `loseCallResponses`, every tool call is answered by Factory but
 * its response never reaches the client.
 */
export async function factoryMcpClient(
  c: TestContext,
  factory: Factory,
  options: { loseCallResponses?: boolean } = {},
) {
  const handler = runtimeMcpHandler(factory.runtime, factory);
  const lost = (init?: RequestInit) =>
    options.loseCallResponses &&
    typeof init?.body === "string" &&
    init.body.includes('"method":"tools/call"');
  const client = new Client({ name: "worker", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: async (url, init) => {
        const response = await handler(new Request(url, init));
        if (!lost(init)) return response;
        // Factory finishes answering before the reply is dropped.
        await response.arrayBuffer();
        throw new TypeError("Response lost");
      },
    }),
  );
  c.onTestFinished(() => client.close());
  return client;
}

/** A session's MCP client, without a Block, on a backend connected to a ready T3. */
export async function authoringMcpClient(c: TestContext) {
  const { factory, t3 } = await openFactoryWithApprovedT3(c);
  return { factory, t3, client: await factoryMcpClient(c, factory) };
}

/** `factory_get_run_image` for one image of the Block's Run. */
export const readRunImage = (client: Client, blockId: string, imageId: string) =>
  client.callTool({ name: "factory_get_run_image", arguments: { blockId, imageId } });

/** `factory_set_run_title`, as the title thread submits its title. */
export const setRunTitle = (client: Client, titleGenerationId: string, title: string) =>
  client.callTool({ name: "factory_set_run_title", arguments: { titleGenerationId, title } });

/** The JSON reply in a Factory tool result's first, text content item. */
export const toolReply = (result: { content: unknown }) =>
  JSON.parse((result.content as [{ text: string }])[0].text);

export const base64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

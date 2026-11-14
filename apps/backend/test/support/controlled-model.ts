import type { TestContext } from "@effect/vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** One request as the provider received it. */
interface ProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

type ProviderAnswer = { readonly status: number; readonly body: unknown };

const chatCompletion = {
  id: "chatcmpl-controlled",
  object: "chat.completion",
  created: 0,
  model: "controlled",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const anthropicMessage = {
  id: "msg_controlled",
  type: "message",
  role: "assistant",
  model: "controlled",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

/**
 * A model provider on loopback, owned by the test rather than by Factory, so it survives a
 * backend restart. It answers OpenAI-compatible chat completions and Anthropic messages, or a
 * scripted failure, and records every request it receives.
 */
export async function controlledModelProvider(context: TestContext) {
  const requests: ProviderRequest[] = [];
  let failure: ProviderAnswer | undefined;
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      requests.push({
        method: request.method ?? "",
        path,
        headers: request.headers,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      });
      const answer = failure ?? {
        status: 200,
        body: path.endsWith("/messages") ? anthropicMessage : chatCompletion,
      };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    /** The provider's address followed by `path`, such as a proxy prefix with its version. */
    baseUrl: (path = "/v1") => origin + path,
    requests,
    /** Every later request is answered with this status and body. */
    fail(status: number, body: unknown) {
      failure = { status, body };
    },
  };
}

/** A base URL nothing listens on. */
export async function unreachableBaseUrl() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

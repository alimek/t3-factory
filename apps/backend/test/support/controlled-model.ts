import type { TestContext } from "@effect/vitest";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request as the provider received it. */
interface ProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

/**
 * One scripted model answer: reply text, tool calls the model requests (Factory runs them and
 * sends the results back in its next request), an HTTP failure, or no answer at all.
 */
type ModelAnswer =
  | { readonly text: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[] }
  | { readonly status: number; readonly body: unknown }
  | { readonly hang: true };

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

/** The answer in the wire format of the endpoint that was called. */
function wireAnswer(
  path: string,
  answer: Exclude<ModelAnswer, { hang: true } | { status: number }>,
  call: () => string,
) {
  const anthropic = path.endsWith("/messages");
  if ("text" in answer)
    return anthropic
      ? {
          id: "msg_controlled",
          type: "message",
          role: "assistant",
          model: "controlled",
          content: [{ type: "text", text: answer.text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      : {
          id: "chatcmpl-controlled",
          object: "chat.completion",
          created: 0,
          model: "controlled",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: answer.text },
              finish_reason: "stop",
            },
          ],
          usage,
        };
  return anthropic
    ? {
        id: "msg_controlled",
        type: "message",
        role: "assistant",
        model: "controlled",
        content: answer.toolCalls.map((entry) => ({
          type: "tool_use",
          id: `toolu_${call()}`,
          name: entry.name,
          input: entry.input,
        })),
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    : {
        id: "chatcmpl-controlled",
        object: "chat.completion",
        created: 0,
        model: "controlled",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: answer.toolCalls.map((entry) => ({
                id: `call_${call()}`,
                type: "function",
                function: { name: entry.name, arguments: JSON.stringify(entry.input) },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      };
}

type Pending = ModelAnswer | Promise<ModelAnswer>;

/**
 * A model provider on loopback, owned by the test rather than by Factory, so it survives a
 * backend restart and a new backend cannot reset its script. It answers OpenAI-compatible chat
 * completions and Anthropic messages: scripted answers in order, then a persistent failure if one
 * is set, then the reply "OK". It records every request it receives.
 */
async function startControlledModel() {
  const requests: ProviderRequest[] = [];
  const script: Pending[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const hanging = new Set<ServerResponse>();
  let failure: { status: number; body: unknown } | undefined;
  let calls = 0;
  const call = () => String(++calls);
  const answer = (response: ServerResponse, path: string, chosen: ModelAnswer) => {
    if ("hang" in chosen) {
      hanging.add(response);
      response.on("close", () => hanging.delete(response));
      return;
    }
    const status = "status" in chosen ? chosen.status : 200;
    const body = "status" in chosen ? chosen.body : wireAnswer(path, chosen, call);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
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
      for (const waiter of waiters.filter((entry) => requests.length >= entry.count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      const next = script.shift() ?? failure ?? { text: "OK" };
      void Promise.resolve(next).then((chosen) => answer(response, path, chosen));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    /** The provider's address followed by `path`, such as a proxy prefix with its version. */
    baseUrl: (path = "/v1") => origin + path,
    requests,
    /** The bodies of chat requests in arrival order. */
    bodies: () => requests.map((request) => request.body),
    /** Answers the next requests with these, in order. */
    script(...answers: ModelAnswer[]) {
      script.push(...answers);
    },
    /** The next request waits for the answer the test releases. */
    held() {
      let release!: (answer: ModelAnswer) => void;
      script.push(new Promise<ModelAnswer>((resolve) => (release = resolve)));
      return { release };
    },
    /** Every later request without a scripted answer is answered with this status and body. */
    fail(status: number, body: unknown) {
      failure = { status, body };
    },
    /** Resolves once the provider has received `count` requests in total. */
    requested(count = 1) {
      return requests.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    close() {
      for (const response of hanging) response.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type ControlledModel = Awaited<ReturnType<typeof startControlledModel>>;

/** The controlled model provider for one vitest test, closed when the test finishes. */
export async function controlledModelProvider(context: TestContext) {
  const provider = await startControlledModel();
  context.onTestFinished(() => provider.close());
  return provider;
}

/** A base URL nothing listens on. */
export async function unreachableBaseUrl() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

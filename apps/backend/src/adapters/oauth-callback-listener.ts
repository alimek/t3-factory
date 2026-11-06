import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as HttpServer from "effect/http/HttpServer";

/** The plain-text answer the browser sees for one callback request. */
export interface CallbackReply {
  readonly status: number;
  readonly body: string;
}

export interface CallbackRequest {
  readonly method: string;
  readonly url: URL;
}

/** A bound loopback listener; `close` resolves once the port is released. */
export interface CallbackListener {
  readonly redirectUrl: string;
  close(): Promise<void>;
}

const failedCallback: CallbackReply = { status: 400, body: "OAuth callback could not complete." };

// One-shot browser redirects: no caching, no referrer, no idle keep-alive holding the listener open.
const callbackHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  connection: "close",
};

// Closing the listener lets an in-flight reply (e.g. the completion page) flush before interruption.
const shutdownGrace = Duration.seconds(1);

function callbackApp(handle: (request: CallbackRequest) => Promise<CallbackReply>) {
  return HttpRouter.addAll([
    HttpRouter.route("*", "/*", (request) =>
      Effect.promise(() =>
        handle({ method: request.method, url: new URL(request.url, "http://127.0.0.1") }),
      ).pipe(
        Effect.catchCause(() => Effect.succeed(failedCallback)),
        Effect.map(({ status, body }) =>
          HttpServerResponse.text(body, { status, headers: callbackHeaders }),
        ),
      ),
    ),
  ]);
}

/** Serves every request on `127.0.0.1:port` (0 = ephemeral) through `handle` until closed. */
export async function listenOAuthCallback(
  port: number,
  handle: (request: CallbackRequest) => Promise<CallbackReply>,
): Promise<CallbackListener> {
  const layer = HttpRouter.serve(callbackApp(handle), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => createServer(), {
        host: "127.0.0.1",
        port,
        gracefulShutdownTimeout: shutdownGrace,
      }),
    ),
  );
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const services = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const address = Context.get(services, HttpServer.HttpServer).address;
    return { redirectUrl: `${HttpServer.formatAddress(address)}/callback`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

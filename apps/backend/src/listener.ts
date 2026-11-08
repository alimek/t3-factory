import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

/** `host`: loopback, host-local trust. `remote`: approved clients over TLS only. */
export type Surface = "host" | "remote";

type Handler = (request: HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse>;

const layerTransportGuard = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) =>
      HttpServerResponse.setHeader(response, "x-content-type-options", "nosniff"),
    ),
  { global: true },
);

export interface Listener {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

/** Binds one Node server in its own scope; closing it leaves other listeners running. */
export async function listen(
  nodeServer: Server,
  host: string,
  port: number,
  handle: Handler,
): Promise<Listener> {
  const app = HttpRouter.addAll([HttpRouter.route("*", "/*", handle)]).pipe(
    Layer.provide(layerTransportGuard),
  );
  const layerServer = HttpRouter.serve(app, { disableLogger: true }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => nodeServer, { host, port, gracefulShutdownTimeout: 0 }),
    ),
  );
  // closeAllConnections skips upgraded sockets; ending them here does not wait for a peer's
  // close handshake and discards data still queued for it.
  const upgraded = new Set<Duplex>();
  nodeServer.on("upgrade", (_request, socket: Duplex) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
  });
  const scope = await Effect.runPromise(Scope.make());
  try {
    await Effect.runPromise(
      Layer.buildWithScope(layerServer, scope).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe()),
      ),
    );
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    address: nodeServer.address() as AddressInfo,
    close: () =>
      (closing ??= Effect.runPromise(
        Effect.gen(function* () {
          nodeServer.closeIdleConnections();
          // Revoked or stopped access must not survive on kept-alive sockets.
          nodeServer.closeAllConnections();
          for (const socket of upgraded) socket.destroy();
          yield* Scope.close(scope, Exit.void);
        }),
      )),
  };
}

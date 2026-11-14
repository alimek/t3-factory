import { toIncomingMessage } from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { FactoryLive } from "@t3-factory/contracts/live-rpc";
import type { Result } from "@t3-factory/contracts";
import { resultResponse } from "./http-support.ts";
import type { LiveStreams } from "./live-streams.ts";

/**
 * The `FactoryLive` RPC server shared by both listeners, and the live sockets of approved
 * clients so that revoking a client ends its delivery. Callers admit the upgrade request first;
 * closing a listener destroys its own upgraded sockets.
 */
export async function startLiveTransport(live: LiveStreams) {
  const scope = await Effect.runPromise(Scope.make());
  const rpc = await Effect.runPromise(
    RpcServer.toHttpEffectWebsocket(FactoryLive).pipe(
      Effect.provide(
        FactoryLive.toLayer({
          WatchConnection: () => live.watchConnection(),
          WatchRunView: (view) => live.watchRunView(view),
          WatchLaunchChoices: () => live.watchLaunchChoices(),
          WatchAppearance: () => live.watchAppearance(),
          WatchStudio: () => live.watchStudio(),
        }),
      ),
      Effect.provide(RpcSerialization.layerJson),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  const clientSockets = new Map<string, Set<() => void>>();
  return {
    /**
     * Upgrades an admitted request and serves it until the socket closes. `authenticate`
     * names the approved client on the remote surface and is null on the host surface.
     */
    serve(
      request: HttpServerRequest.HttpServerRequest,
      authenticate: Effect.Effect<Result<string | null>>,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse> {
      return Effect.scoped(
        Effect.gen(function* () {
          const client = yield* authenticate;
          if (!client.ok) return resultResponse(client);
          const clientId = client.value;
          if (clientId !== null) {
            const socket = toIncomingMessage(request).socket;
            // Destroying the socket also discards data still queued for the client.
            const close = () => socket.destroy();
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const sockets = clientSockets.get(clientId) ?? new Set();
                sockets.add(close);
                clientSockets.set(clientId, sockets);
              }),
              () =>
                Effect.sync(() => {
                  const sockets = clientSockets.get(clientId);
                  sockets?.delete(close);
                  if (sockets?.size === 0) clientSockets.delete(clientId);
                }),
            );
            // A revocation between the first check and registration found nothing to close.
            const registered = yield* authenticate;
            if (!registered.ok) return resultResponse(registered);
          }
          return yield* rpc.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          );
        }),
      );
    },
    closeClient(clientId: string) {
      for (const close of clientSockets.get(clientId) ?? []) close();
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
export type LiveTransport = Awaited<ReturnType<typeof startLiveTransport>>;

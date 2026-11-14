import { Cause, Effect, Layer, Schedule, Stream } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import type { LiveEnvelope, OperationError } from "@t3-factory/contracts";
import { FactoryLive } from "@t3-factory/contracts/live-rpc";
import type { LiveEnvironment, LiveWatch, SubscriptionEvents } from "./owner.ts";

type Client = RpcClient.FromGroup<typeof FactoryLive, RpcClientError.RpcClientError>;

type LiveStream = Stream.Stream<
  LiveEnvelope<{ readonly _tag: string }>,
  OperationError | RpcClientError.RpcClientError
>;

function watchStream(client: Client, watch: LiveWatch): LiveStream {
  if (watch.rpc === "WatchConnection") return client.WatchConnection();
  if (watch.rpc === "WatchLaunchChoices") return client.WatchLaunchChoices();
  if (watch.rpc === "WatchStudio") return client.WatchStudio();
  if (watch.rpc === "WatchAppearance") return client.WatchAppearance();
  return client.WatchRunView({ navigation: watch.navigation, runIds: watch.runIds });
}

/**
 * One socket per session. Socket retries are disabled here: the owner decides reconnects so it
 * can fence old sessions, resubscribe every scope and classify repeated open failures.
 */
export function rpcSessions(
  url: string,
  constructor: Layer.Layer<Socket.WebSocketConstructor>,
): LiveEnvironment["open"] {
  return (events) => {
    const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.sync(events.connected),
      onDisconnect: Effect.sync(events.disconnected),
    });
    const protocol = RpcClient.layerProtocolSocket({
      pingInterval: "10 seconds",
      pingTimeout: "20 seconds",
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Layer.provide(Socket.layerWebSocket(url)),
      Layer.provide(constructor),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(hooks),
    );
    let resolveClient: (client: Client) => void = () => undefined;
    const ready = new Promise<Client>((resolve) => {
      resolveClient = resolve;
    });
    const closeSession = Effect.runCallback(
      Effect.gen(function* () {
        resolveClient(yield* RpcClient.make(FactoryLive));
        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.provide(protocol)),
    );
    const subscriptions = new Set<() => void>();
    return {
      subscribe(watch, handlers) {
        const cancel = subscribe(ready, watch, handlers);
        subscriptions.add(cancel);
        return () => {
          subscriptions.delete(cancel);
          cancel();
        };
      },
      close() {
        for (const cancel of subscriptions) cancel();
        subscriptions.clear();
        closeSession();
      },
    };
  };
}

function subscribe(ready: Promise<Client>, watch: LiveWatch, handlers: SubscriptionEvents) {
  let cancelled = false;
  const interrupt = Effect.runCallback(
    Effect.promise(() => ready).pipe(
      Effect.flatMap((client) =>
        Stream.runForEach(watchStream(client, watch), (envelope) =>
          Effect.sync(() => handlers.message(envelope)),
        ),
      ),
    ),
    {
      onExit(exit) {
        if (cancelled) return;
        if (exit._tag === "Success") return handlers.lost();
        const error = Cause.findErrorOption(exit.cause);
        if (error._tag === "Some" && !(error.value instanceof RpcClientError.RpcClientError))
          return handlers.failed(error.value);
        handlers.lost();
      },
    },
  );
  return () => {
    cancelled = true;
    interrupt();
  };
}

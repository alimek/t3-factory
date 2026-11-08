import type { TestContext } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { WebSocket } from "@effect/platform-node/NodeWS";
import {
  LIVE_PATH,
  applyRunChange,
  type RunDetail,
  type RunLiveMessage,
} from "@t3-factory/contracts";
import { FactoryLive } from "@t3-factory/contracts/live-rpc";

/**
 * A running subscription to a live stream, as one window consumes it: every message in
 * arrival order, waits for a condition over them, and the stream's end.
 */
export function subscribe<A, E>(context: TestContext, stream: Stream.Stream<A, E>) {
  const messages: A[] = [];
  const waiters = new Set<() => void>();
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (message) =>
      Effect.sync(() => {
        messages.push(message);
        for (const wake of waiters) wake();
      }),
    ),
  );
  const ended = new Promise<Exit.Exit<void, E>>((resolve) => fiber.addObserver(resolve));
  context.onTestFinished(() => Effect.runPromise(Fiber.interrupt(fiber)));
  return {
    messages,
    ended,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
    /** Resolves with the messages once `condition` holds for them; rejects if the stream ends. */
    until(condition: (received: readonly A[]) => boolean): Promise<readonly A[]> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!condition(messages)) return;
          waiters.delete(check);
          resolve([...messages]);
        };
        waiters.add(check);
        void ended.then((exit) => {
          waiters.delete(check);
          reject(new Error(`The live stream ended: ${String(exit)}`));
        });
        check();
      });
    },
  };
}

/** The Run a client holds after applying `messages` in order, as the Run screen does. */
export function appliedRun(messages: readonly RunLiveMessage[]): RunDetail | undefined {
  let run: RunDetail | undefined;
  for (const message of messages)
    run = message._tag === "snapshot" ? message.run : run && applyRunChange(run, message);
  return run;
}

/** Live delivery never sends the internal concurrency generation after the snapshot. */
export const withoutGeneration = (run: RunDetail | undefined) => run && { ...run, generation: 0 };

export interface LiveEndpoint {
  /** `ws://` or `wss://` origin of the listener. */
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Trust anchor for the approved-client listener. */
  readonly ca?: string;
  readonly protocol: { readonly protocol: number; readonly minimum: number };
}

const liveUrl = (endpoint: LiveEndpoint) =>
  `${endpoint.base}${LIVE_PATH}?protocol=${endpoint.protocol.protocol}&minimum=${endpoint.protocol.minimum}`;

/** The HTTP status with which the server refused to upgrade a live connection. */
export function refusedUpgrade(endpoint: LiveEndpoint): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(liveUrl(endpoint), {
      headers: { ...endpoint.headers },
      ...(endpoint.ca ? { ca: endpoint.ca } : {}),
    });
    socket.on("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("The live connection was upgraded."));
    });
  });
}

/** One window's `FactoryLive` RPC client over a real WebSocket, closed after the test. */
export async function liveClient(context: TestContext, endpoint: LiveEndpoint) {
  const constructor = Layer.succeed(Socket.WebSocketConstructor)(
    (url) =>
      new WebSocket(url, {
        headers: { ...endpoint.headers },
        ...(endpoint.ca ? { ca: endpoint.ca } : {}),
      }),
  );
  const protocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
    Layer.provide(Socket.layerWebSocket(liveUrl(endpoint))),
    Layer.provide(constructor),
    Layer.provide(RpcSerialization.layerJson),
  );
  const scope = Scope.makeUnsafe();
  context.onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(protocol, scope);
      return yield* RpcClient.make(FactoryLive).pipe(Effect.provide(context));
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
}

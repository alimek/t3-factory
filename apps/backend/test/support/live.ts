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
  type LiveEnvelope,
  type NavigationLiveMessage,
  type RunDetail,
  type RunViewLiveMessage,
  type RunLiveMessage,
} from "@t3-factory/contracts";
import { FactoryLive } from "@t3-factory/contracts/live-rpc";
import type { Factory } from "@t3-factory/backend";
import type { LiveStreams, makeLiveStreams } from "../../src/live-streams.ts";

/**
 * A running subscription to a live stream, as one window consumes it: every envelope and the
 * messages they carry in arrival order, waits for a condition over the messages, and the
 * stream's end.
 */
export function subscribe<A, E>(context: TestContext, stream: Stream.Stream<LiveEnvelope<A>, E>) {
  const envelopes: LiveEnvelope<A>[] = [];
  const messages: A[] = [];
  const waiters = new Set<() => void>();
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (envelope) =>
      Effect.sync(() => {
        envelopes.push(envelope);
        messages.push(...envelope.messages);
        for (const wake of waiters) wake();
      }),
    ),
  );
  const ended = new Promise<Exit.Exit<void, E>>((resolve) => fiber.addObserver(resolve));
  context.onTestFinished(() => Effect.runPromise(Fiber.interrupt(fiber)));
  return {
    envelopes,
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

/** The envelopes of a view subscription with only the messages `pick` selects. */
const project = <M, E>(
  stream: Stream.Stream<LiveEnvelope<RunViewLiveMessage>, E>,
  pick: (message: RunViewLiveMessage) => M | undefined,
): Stream.Stream<LiveEnvelope<M>, E> =>
  Stream.map(stream, (envelope) => ({
    current: envelope.current,
    messages: envelope.messages.flatMap((message) => {
      const picked = pick(message);
      return picked === undefined ? [] : [picked];
    }),
  }));

/** One Run's messages, from a view that holds only that Run. */
export const watchRun = (live: LiveStreams, runId: string) =>
  project(live.watchRunView({ navigation: false, runIds: [runId] }), (message) =>
    message._tag === "run" && message.runId === runId ? message.message : undefined,
  );

/** Navigation messages, from a view that holds only navigation. */
export const watchNavigation = (live: LiveStreams) =>
  project(
    live.watchRunView({ navigation: true, runIds: [] }),
    (message): NavigationLiveMessage | undefined =>
      message._tag === "navigation" ? message.message : undefined,
  );

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

/** The factory's public reads, for live streams built over a replaced read. */
export const liveReads = (factory: Factory): Parameters<typeof makeLiveStreams>[1] => ({
  getConnection: () => Effect.promise(() => factory.getConnection()),
  listRunNavigation: () => Effect.promise(() => factory.listRunNavigation()),
  getRun: (id) => Effect.promise(() => factory.getRun(id)),
  readProjectCatalog: () => Effect.promise(() => factory.listProjects()),
  listFlows: () => Effect.promise(() => factory.listFlows()),
});

/** Commit after capturing the first read, before the subscriber receives its value. */
export function raceFirstRead<A, E>(read: Effect.Effect<A, E>, commit: () => Promise<void>) {
  let first = true;
  return read.pipe(
    Effect.tap(() => {
      if (!first) return Effect.void;
      first = false;
      return Effect.promise(commit);
    }),
  );
}

import type { TestContext } from "@effect/vitest";
import { STATUS_CODES, type IncomingHttpHeaders } from "node:http";
import { MessageChannel } from "node:worker_threads";
import { WebSocketServer, type WebSocket } from "ws";
import { FACTORY_MINIMUM_SERVER_PROTOCOL, FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import type { ApprovedClient } from "../../../desktop/src/approved-client.ts";
import { livePath, relayLive, type LivePort } from "../../../desktop/src/live-relay.ts";
import { currentConnection, handshakeServer } from "./desktop-client.ts";

type Delivery =
  | { readonly type: "open" }
  | { readonly type: "message"; readonly data: string | Uint8Array }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

/** The renderer end of a live port, as Electron's MessagePortMain pair would present it. */
function rendererPort() {
  const { port1, port2 } = new MessageChannel();
  const received: Delivery[] = [];
  const listeners = new Set<() => void>();
  port2.on("message", (message: Delivery) => {
    received.push(message);
    for (const listener of listeners) listener();
  });
  const main = {
    postMessage: (message: Delivery) => port1.postMessage(message),
    on: (event: "message" | "close", listener: (event?: { data: unknown }) => void) =>
      event === "message"
        ? port1.on("message", (data: unknown) => listener({ data }))
        : port1.on("close", () => listener()),
    start: () => port1.start(),
    close: () => port1.close(),
  } as LivePort;
  return {
    main,
    received,
    send: (message: unknown) => port2.postMessage(message),
    /** Resolves with the first delivery matching `type`, waiting for it if needed. */
    next<T extends Delivery["type"]>(type: T): Promise<Extract<Delivery, { type: T }>> {
      const find = () => received.find((message) => message.type === type);
      return new Promise((resolve) => {
        const check = () => {
          const found = find();
          if (!found) return;
          listeners.delete(check);
          resolve(found as Extract<Delivery, { type: T }>);
        };
        listeners.add(check);
        check();
      });
    },
  };
}

export const liveQuery = `protocol=${FACTORY_PROTOCOL}&minimum=${FACTORY_MINIMUM_SERVER_PROTOCOL}`;

/** Opens a client-role live channel the way the main process does for a renderer request. */
export function openRemoteLive(client: ApprovedClient, query = liveQuery) {
  const renderer = rendererPort();
  relayLive(currentConnection(client).openSocket(livePath(query)), renderer.main);
  return renderer;
}

/**
 * A pinned-TLS server with a WebSocket endpoint standing in for `/api/live`: it echoes
 * frames, records each upgrade request, or refuses upgrades with `refusal` before 101.
 */
export async function liveServer(context: TestContext, refusal?: number) {
  const upgrades: { readonly url: string; readonly headers: IncomingHttpHeaders }[] = [];
  const sockets: WebSocket[] = [];
  const connected = new Set<(socket: WebSocket) => void>();
  const { server, url } = await handshakeServer(context, (_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const live = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    upgrades.push({ url: request.url ?? "", headers: request.headers });
    if (refusal) {
      socket.end(
        `HTTP/1.1 ${refusal} ${STATUS_CODES[refusal]}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      );
      return;
    }
    live.handleUpgrade(request, socket, head, (accepted) => {
      accepted.on("message", (data, binary) => accepted.send(data, { binary }));
      sockets.push(accepted);
      for (const listener of connected) listener(accepted);
    });
  });
  // Upgraded sockets are not closed by the HTTPS server's teardown.
  context.onTestFinished(() => {
    for (const socket of live.clients) socket.terminate();
  });
  return {
    url,
    upgrades,
    /** The server end of the first accepted live socket. */
    accepted: (): Promise<WebSocket> =>
      sockets[0] ? Promise.resolve(sockets[0]) : new Promise((resolve) => connected.add(resolve)),
  };
}

export const closed = (socket: WebSocket) =>
  new Promise<void>((resolve) =>
    socket.readyState === socket.CLOSED ? resolve() : socket.once("close", () => resolve()),
  );

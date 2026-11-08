import { LIVE_PATH } from "@t3-factory/contracts";
import { WebSocket } from "ws";

/**
 * Main → renderer messages on a live port. A refused upgrade closes with 4000 + the HTTP
 * status (4401 unauthorized, 4426 incompatible) so the renderer can reach its gates; any
 * other failure closes with 1006 and the network error code as reason.
 */
type LiveDelivery =
  | { readonly type: "open" }
  | { readonly type: "message"; readonly data: string | Uint8Array }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

/** The part of Electron's `MessagePortMain` a live channel uses. */
export interface LivePort {
  postMessage(message: LiveDelivery): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}

/** Only the declared protocol range reaches the server; the renderer chooses nothing else. */
export function livePath(query: string): string {
  const declared = new URLSearchParams(query);
  const forwarded = new URLSearchParams();
  for (const name of ["protocol", "minimum"]) {
    const value = declared.get(name);
    if (value !== null && /^\d{1,6}$/.test(value)) forwarded.set(name, value);
  }
  return `${LIVE_PATH}?${forwarded}`;
}

/** Host role: the supervised local backend, admitted as its own loopback origin. */
export const hostLiveSocket = (base: string, path: string) =>
  new WebSocket(base.replace(/^http/, "ws") + path, { origin: base, handshakeTimeout: 10_000 });

export function refuseLive(port: LivePort, reason: string) {
  port.postMessage({ type: "close", code: 1006, reason });
  port.close();
}

/** A renderer may close with 1000 or an application code; anything else closes normally. */
const rendererCloseCode = (code: unknown) =>
  typeof code === "number" && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;

/**
 * Relays one live WebSocket over a renderer port until either side closes. Frames are
 * forwarded only while the socket is open, so a terminated (invalidated) socket delivers
 * nothing it had already buffered.
 */
export function relayLive(socket: WebSocket, port: LivePort, ended?: () => void) {
  let closed = false;
  const end = (delivery: { code: number; reason: string } | null) => {
    if (closed) return;
    closed = true;
    if (delivery) port.postMessage({ type: "close", ...delivery });
    port.close();
    // Open sockets were already closed or terminated by the caller; a handshake is aborted.
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    ended?.();
  };
  socket.on("open", () => {
    if (!closed) port.postMessage({ type: "open" });
  });
  socket.on("message", (data, binary) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    // The default "nodebuffer" binary type delivers each message as one Buffer.
    const bytes = data as Buffer;
    // A copy, so the transfer does not clone the pooled buffer behind the view.
    port.postMessage({ type: "message", data: binary ? new Uint8Array(bytes) : bytes.toString() });
  });
  socket.on("unexpected-response", (_request, response) => {
    const status = response.statusCode ?? 0;
    end(
      status >= 400 && status <= 599
        ? { code: 4000 + status, reason: response.statusMessage ?? "" }
        : { code: 1006, reason: `Unexpected HTTP ${status}` },
    );
  });
  socket.on("error", (error: NodeJS.ErrnoException) =>
    end({ code: 1006, reason: typeof error.code === "string" ? error.code : "" }),
  );
  socket.on("close", (code, reason) => end({ code, reason: reason.toString() }));
  port.on("message", ({ data }) => {
    if (closed || typeof data !== "object" || data === null) return;
    const message = data as { type?: unknown; data?: unknown; code?: unknown; reason?: unknown };
    if (message.type === "message") {
      const frame = message.data;
      if (
        socket.readyState === WebSocket.OPEN &&
        (typeof frame === "string" || frame instanceof Uint8Array)
      )
        socket.send(frame);
    } else if (message.type === "close") {
      // A close frame carries at most 123 bytes of reason; ws throws on longer ones.
      const reason =
        typeof message.reason === "string" && Buffer.byteLength(message.reason) <= 123
          ? message.reason
          : "";
      if (socket.readyState === WebSocket.OPEN)
        socket.close(rendererCloseCode(message.code), reason);
      end(null);
    }
  });
  port.on("close", () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1001);
    end(null);
  });
  port.start();
  return {
    /** Selection or backend changes end the channel at once; nothing later is delivered. */
    close(reason: string) {
      socket.terminate();
      end({ code: 1001, reason });
    },
  };
}

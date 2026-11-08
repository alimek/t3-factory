import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

type FixtureTls = { readonly ca: string };

/**
 * Keep the browser origin check meaningful when fixtures use a private backend port.
 * With `tls`, the fixture reaches an approved-client listener trusting only its CA.
 */
function forwardRequest(incoming: IncomingMessage, port: number, tls?: FixtureTls): ClientRequest {
  const headers = { ...incoming.headers, host: `127.0.0.1:${port}` };
  const scheme = tls ? "https" : "http";
  if (headers.origin === `http://${incoming.headers.host}`)
    headers.origin = `${scheme}://${headers.host}`;
  const options = {
    hostname: "127.0.0.1",
    port,
    path: incoming.url,
    method: incoming.method,
    headers,
  };
  return tls ? httpsRequest({ ...options, ca: tls.ca }) : httpRequest(options);
}

export function proxyFixture(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  port: number,
  tls?: FixtureTls,
) {
  const forwarded = forwardRequest(incoming, port, tls);
  forwarded.on("response", (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  forwarded.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(forwarded);
}

function statusHead(response: IncomingMessage) {
  const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2)
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** Relays the live WebSocket upgrade, including a refusal answered before the upgrade. */
export function proxyFixtureUpgrade(
  incoming: IncomingMessage,
  socket: Duplex,
  port: number,
  tls?: FixtureTls,
) {
  const forwarded = forwardRequest(incoming, port, tls);
  forwarded.on("upgrade", (response, upstream, head) => {
    socket.write(statusHead(response));
    if (head.length > 0) socket.write(head);
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.pipe(socket).pipe(upstream);
  });
  forwarded.on("response", (response) => {
    socket.write(statusHead(response));
    response.pipe(socket);
  });
  forwarded.on("error", () => socket.destroy());
  socket.on("error", () => forwarded.destroy());
  forwarded.end();
}

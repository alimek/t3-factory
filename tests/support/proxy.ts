import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Keep the browser origin check meaningful when fixtures use a private backend port.
 * With `tls`, the fixture reaches an approved-client listener trusting only its CA.
 */
export function proxyFixture(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  port: number,
  tls?: { readonly ca: string },
) {
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
  const forward = (response: IncomingMessage) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  };
  const forwarded = tls
    ? httpsRequest({ ...options, ca: tls.ca }, forward)
    : httpRequest(options, forward);
  forwarded.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(forwarded);
}

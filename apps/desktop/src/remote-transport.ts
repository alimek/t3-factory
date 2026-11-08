import { X509Certificate, createHash } from "node:crypto";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, connect, type DetailedPeerCertificate } from "node:tls";
import { WebSocket } from "ws";
import type { ServerTrust } from "./settings-store.ts";

/** Uppercase colon-separated SHA-256 of the DER certificate, matching the host panel. */
function fingerprintOf(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g)!.join(":");
}

const toPem = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END CERTIFICATE-----\n`;

export interface ServerProbe {
  readonly url: string;
  readonly trust: ServerTrust;
  readonly fingerprint: string;
  readonly matchesExpected: boolean;
  readonly systemTrusted: boolean;
}

/** The address the user typed, plus an optional `#sha256=<fingerprint>` from the host panel. */
function parseServerAddress(
  address: string,
): { readonly url: URL; readonly expected: string | null } | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const expected = /^#sha256=([0-9A-Fa-f:]{64,95})$/.exec(url.hash)?.[1] ?? null;
  return {
    url: new URL(url.origin),
    expected: expected ? expected.replaceAll(":", "").toUpperCase().match(/../g)!.join(":") : null,
  };
}

/** The certificate a client should pin: the self-signed authority at the top of the chain. */
function trustAnchor(peer: DetailedPeerCertificate): Buffer {
  let current: DetailedPeerCertificate = peer;
  while (current.issuerCertificate && current.issuerCertificate !== current) {
    current = current.issuerCertificate;
  }
  const anchor = new X509Certificate(current.raw);
  return anchor.ca ? current.raw : peer.raw;
}

/** Reads the presented chain without trusting it yet (trust on first use, confirmed by the user). */
function presentedChain(
  url: URL,
  signal: AbortSignal,
): Promise<{ peer: DetailedPeerCertificate; systemTrusted: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket = connect({
      host,
      port: Number(url.port || 443),
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      timeout: 10_000,
    });
    const cancel = () => socket.destroy(new Error("Server probe cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", cancel));
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      const systemTrusted = socket.authorized && checkServerIdentity(host, peer) === undefined;
      socket.end();
      resolve({ peer, systemTrusted });
    });
    socket.once("timeout", () => socket.destroy(new Error("timeout")));
    socket.once("error", reject);
  });
}

export interface RemoteReply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** One selected server's TLS pool and live sockets; the Approved client owns their lifetime. */
export class RemoteTransport {
  private readonly agent: Agent;
  // Upgraded sockets leave the agent's pool, so destroying the agent does not close them.
  private readonly sockets = new Set<WebSocket>();
  private closed = false;

  constructor(private readonly server: { url: string; trust: ServerTrust }) {
    this.agent = new Agent({
      keepAlive: true,
      // Pinning limits issuers; it never replaces verification of the selected host.
      ...(server.trust.mode === "pinned" ? { ca: server.trust.anchor } : {}),
    });
  }

  close() {
    this.closed = true;
    this.agent.destroy();
    for (const socket of this.sockets) socket.terminate();
  }

  /** A WebSocket through the same pinned agent and hostname verification as requests. */
  openSocket(path: string, headers: Record<string, string>): WebSocket {
    if (this.closed) throw new Error("The server connection was closed.");
    const url = new URL(path, this.server.url);
    url.protocol = "wss:";
    const socket = new WebSocket(url, {
      agent: this.agent,
      headers,
      origin: new URL(this.server.url).origin,
      handshakeTimeout: 10_000,
    });
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    return socket;
  }

  request(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    signal?: AbortSignal,
  ): Promise<RemoteReply> {
    if (this.closed) return Promise.reject(new Error("The server connection was closed."));
    const url = new URL(path, this.server.url);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          signal,
          headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
          agent: this.agent,
          timeout: 30_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: Object.fromEntries(
                Object.entries(response.headers).flatMap(([name, value]) =>
                  typeof value === "string" ? [[name, value]] : [],
                ),
              ),
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
}

/** Confirms the address answers the Factory handshake and describes its certificate. */
export async function probeServer(address: string, signal: AbortSignal): Promise<ServerProbe> {
  const parsed = parseServerAddress(address);
  if (!parsed)
    throw new Error(
      "Enter the server's https:// address, for example https://factory.tail.example:4312.",
    );
  const { peer, systemTrusted } = await presentedChain(parsed.url, signal);
  const anchor = trustAnchor(peer);
  const fingerprint = fingerprintOf(anchor);
  const trust: ServerTrust = systemTrusted
    ? { mode: "system", fingerprint }
    : { mode: "pinned", anchor: toPem(anchor), fingerprint };
  const transport = new RemoteTransport({ url: parsed.url.origin, trust });
  let reply: RemoteReply;
  try {
    reply = await transport.request(
      "GET",
      "/api/protocol",
      { accept: "application/json" },
      undefined,
      signal,
    );
  } finally {
    transport.close();
  }
  const body = JSON.parse(reply.body.toString("utf8")) as {
    ok?: boolean;
    value?: { protocol?: unknown };
  };
  if (reply.status !== 200 || body.ok !== true || typeof body.value?.protocol !== "number")
    throw new Error("That address answered, but not as a Factory server.");
  return {
    url: parsed.url.origin,
    trust,
    fingerprint,
    matchesExpected: parsed.expected === fingerprint,
    systemTrusted,
  };
}

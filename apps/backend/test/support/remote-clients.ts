import { assert, type TestContext } from "@effect/vitest";
import { text as readStreamText, buffer as readStreamBuffer } from "node:stream/consumers";
import { Agent, request } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientKind, FactoryClient, Result, ServerUpdateAction } from "@t3-factory/contracts";
import { FACTORY_MINIMUM_SERVER_PROTOCOL, FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import { loadConfiguration } from "@t3-factory/backend/config";
import {
  startServer,
  type ApplicationUpdates,
  type ServerOptions,
} from "@t3-factory/backend/server";
import { prepared } from "./prepared-runner.ts";
import { installFirstReportingTarget, reportingFixture } from "./reporting.ts";
import type { LiveEndpoint } from "./live.ts";

interface Reply<A = unknown> {
  readonly status: number;
  readonly body: Result<A>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * One desktop installation or browser profile on another device: its own TLS trust,
 * kept-alive session and credential, talking to the approved-client listener.
 */
class RemoteClient {
  id = "";
  credential = "";
  cookie = "";
  private readonly agent: Agent;
  constructor(
    private readonly base: () => string,
    private readonly trustAnchor: string,
    readonly kind: ClientKind,
    readonly protocol = { protocol: FACTORY_PROTOCOL, minimum: FACTORY_MINIMUM_SERVER_PROTOCOL },
  ) {
    this.agent = new Agent({ keepAlive: true, ca: trustAnchor });
  }

  /** The live endpoint as this client's window or desktop main process opens it. */
  live(): LiveEndpoint {
    const { host } = new URL(this.base());
    return {
      base: `wss://${host}`,
      ca: this.trustAnchor,
      protocol: this.protocol,
      headers: {
        origin: `https://${host}`,
        ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
    };
  }

  private options(
    method: string,
    path: string,
    headers: Record<string, string>,
    declareProtocol = true,
  ) {
    const url = new URL(path, this.base());
    return {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      agent: this.agent,
      headers: {
        ...(declareProtocol
          ? {
              "x-factory-protocol": String(this.protocol.protocol),
              "x-factory-protocol-minimum": String(this.protocol.minimum),
            }
          : {}),
        ...(method === "GET" ? {} : { "x-factory-request": "1" }),
        ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
    };
  }

  /** Image loads carry the session credential, but cannot add application headers. */
  asset(
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
  ): Promise<{ status: number; data: Buffer; contentType: string | undefined }> {
    return new Promise((resolve, reject) => {
      const outgoing = request(this.options(method, path, headers, false), (response) => {
        void readStreamBuffer(response).then(
          (data) =>
            resolve({
              status: response.statusCode ?? 0,
              data,
              contentType: response.headers["content-type"],
            }),
          reject,
        );
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  /** A request with a raw body, such as an image upload or a HEAD probe; the reply is not JSON. */
  sendBytes(
    method: string,
    path: string,
    body?: { contentType: string; data: Uint8Array },
  ): Promise<{ status: number; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        this.options(method, path, body ? { "content-type": body.contentType } : {}),
        (response) => {
          void readStreamBuffer(response).then(
            (data) => resolve({ status: response.statusCode ?? 0, data }),
            reject,
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body ? Buffer.from(body.data) : undefined);
    });
  }

  send<A = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply<A>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const outgoing = request(
        this.options(method, path, {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...headers,
        }),
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(text),
              headers: response.headers,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
  }

  /**
   * The server accepted and answered, but the connection drops before this client reads
   * the reply: the command outcome is unknown to the client.
   */
  sendLosingResponse(method: string, path: string, body: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const outgoing = request(
        this.options(method, path, { "content-type": "application/json" }),
        (response) => {
          response.socket.destroy();
          resolve();
        },
      );
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
  }

  async requestAccess(label: string): Promise<FactoryClient> {
    const reply = await this.send<{ client: FactoryClient; credential: string }>(
      "POST",
      "/api/client-access/requests",
      { label, kind: this.kind },
    );
    assert(reply.body.ok);
    if (this.kind === "desktop") this.credential = reply.body.value.credential;
    else this.cookie = String(reply.headers["set-cookie"]).split(";")[0]!;
    this.id = reply.body.value.client.id;
    return reply.body.value.client;
  }

  close() {
    this.agent.destroy();
  }
}

/** A desktop server's updater holding a downloaded beta; it records requested actions. */
export function recordingUpdates() {
  const actions: ServerUpdateAction[] = [];
  const updates: ApplicationUpdates = {
    status: () => ({
      channel: "beta",
      update: {
        state: "downloaded",
        version: "0.1.1-beta.3",
        progress: 100,
        downloadedBytes: null,
        totalBytes: null,
        checkedAt: null,
        releaseNotes: null,
        message: null,
      },
    }),
    run: (action) => {
      actions.push(action);
      return Promise.resolve({ ok: true, value: null });
    },
  };
  return { actions, updates };
}

/** A Factory server with secure remote access on loopback ports and a host-local owner panel. */
export async function remoteServer(
  context: TestContext,
  options: ServerOptions & {
    readonly home?: string;
    /** Start with remote access off, as a fresh installation does. */
    readonly remoteDisabled?: true;
    readonly certificate?: { certFile: string; keyFile: string };
    readonly host?: string;
  } = {},
) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "t3-factory-remote-")));
  if (!options.home) context.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const { home: _home, remoteDisabled, certificate, host: bindHost, ...serverOptions } = options;
  const config = await loadConfiguration({
    FACTORY_HOME: home,
    FACTORY_PORT: "0",
    ...(bindHost ? { FACTORY_HOST: bindHost } : {}),
    ...(remoteDisabled ? {} : { FACTORY_REMOTE_ACCESS: "1" }),
    FACTORY_REMOTE_HOST: "127.0.0.1",
    FACTORY_REMOTE_PORT: "0",
  });
  const configured = certificate
    ? { ...config, remoteAccess: { ...config.remoteAccess!, certificate } }
    : config;
  let server = await startServer(configured, { uiDirectory: null, ...serverOptions });
  const clients: RemoteClient[] = [];
  context.onTestFinished(async () => {
    for (const client of clients) client.close();
    await server.close();
  });
  const remoteBase = () => `https://127.0.0.1:${server.remoteAddress()!.port}`;
  const hostBase = () => `http://127.0.0.1:${server.address.port}`;
  const trustAnchor = () => {
    const anchor = server.remoteAccess.trustAnchor();
    assert(anchor);
    return anchor;
  };
  return {
    home,
    get server() {
      return server;
    },
    get factory() {
      return server.factory;
    },
    hostBase,
    trustAnchor,
    /** The live endpoint as a window on the host opens it. */
    hostLive(protocol = { protocol: FACTORY_PROTOCOL, minimum: FACTORY_MINIMUM_SERVER_PROTOCOL }) {
      const { host } = new URL(hostBase());
      return {
        base: `ws://${host}`,
        protocol,
        headers: { origin: `http://${host}` },
      } satisfies LiveEndpoint;
    },
    /** Ordinary browser navigation carries no application protocol or credential headers. */
    downloadCertificate(): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const outgoing = request(
          new URL("/factory-ca.pem", remoteBase()),
          { ca: trustAnchor() },
          (response) => {
            void readStreamText(response).then(
              (text) => resolve({ status: response.statusCode ?? 0, text }),
              reject,
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
    },
    client(kind: ClientKind = "desktop", protocol?: RemoteClient["protocol"]) {
      const client = new RemoteClient(remoteBase, trustAnchor(), kind, protocol);
      clients.push(client);
      return client;
    },
    /** The owner's host-local panel on the loopback listener. */
    async host<A = unknown>(method: string, path: string, body?: unknown): Promise<Reply<A>> {
      const response = await fetch(hostBase() + path, {
        method,
        headers: {
          ...(method === "GET" ? {} : { "X-Factory-Request": "1" }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Result<A>,
        headers: Object.fromEntries(response.headers),
      };
    },
    async approved(
      label: string,
      kind: ClientKind = "desktop",
      protocol?: RemoteClient["protocol"],
    ) {
      const client = this.client(kind, protocol);
      const requested = await client.requestAccess(label);
      assert((await this.host("POST", `/api/host/clients/${requested.id}/approve`)).body.ok);
      return client;
    },
    async restart() {
      await server.close();
      server = await startServer(configured, { uiDirectory: null, ...serverOptions });
    },
  };
}

/** A ready single-Agent Flow on a server whose approved desktop client can Start it remotely. */
export async function remotePrepared(context: TestContext) {
  const fixture = await prepared(context);
  await fixture.f.close();
  const server = await remoteServer(context, {
    home: fixture.h.processHome,
    t3: fixture.t3,
    reportingStateDirectory: join(fixture.h.processHome, "reporting-state"),
    connectionRetryMs: 60_000,
  });
  // The reporting entry must name this server's actual Factory MCP URL.
  await installFirstReportingTarget(server.factory);
  const laptop = await server.approved("Laptop");
  return { ...fixture, server, laptop };
}

/** An approved client and an unconfigured, disposable Codex home on its Factory server. */
export async function remoteReporting(context: TestContext) {
  const fixture = await reportingFixture(context, "codex");
  await fixture.factory.close();
  const server = await remoteServer(context, {
    home: fixture.harness.processHome,
    ...fixture.options,
    connectionRetryMs: 60_000,
  });
  const targets = await server.factory.getReportingInstallations();
  assert(targets.ok);
  const laptop = await server.approved("Laptop");
  return { server, laptop, target: targets.value[0]!, config: fixture.config, home: fixture.home };
}

/** A real Factory listener whose certificate names a different host, used by desktop trust tests. */
export async function wrongHostnameServer(context: TestContext) {
  const { factoryHarness } = await import("./factory.ts");
  const { ensureRemoteCertificate } = await import("../../src/remote-certificates.ts");
  const harness = await factoryHarness(context);
  const credentials = join(harness.processHome, "credentials");
  const certificate = await ensureRemoteCertificate(credentials, {
    dns: ["different.example"],
    ips: [],
  });
  const server = await remoteServer(context, {
    home: harness.processHome,
    certificate: {
      certFile: join(credentials, "tls", "server.pem"),
      keyFile: join(credentials, "tls", "server-key.pem"),
    },
  });
  return {
    server,
    trust: {
      mode: "pinned" as const,
      anchor: certificate.trustAnchor,
      fingerprint: certificate.fingerprint,
    },
  };
}

/** A server whose host saved a controlled T3 endpoint, with one approved desktop client. */
export async function remoteConnection(context: TestContext) {
  const { ControlledT3 } = await import("./controlled-t3.ts");
  const t3 = new ControlledT3();
  const server = await remoteServer(context, { t3, connectionRetryMs: 60_000 });
  const configured = await server.factory.configureConnection({
    endpoint: "https://t3.example/mcp",
  });
  assert(configured.ok);
  const laptop = await server.approved("Laptop");
  return { server, t3, laptop };
}

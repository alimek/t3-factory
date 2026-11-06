import { assert, type TestContext } from "@effect/vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ClientScope, Result } from "@t3-factory/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { ensureRemoteCertificate } from "../../src/remote-certificates.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_MINIMUM_SERVER_PROTOCOL, FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import { ApprovedClient, type CredentialProtection } from "../../../desktop/src/approved-client.ts";
import { factoryProtocolHandler } from "../../../desktop/src/protocol.ts";
import { SettingsStore } from "../../../desktop/src/settings-store.ts";
import { remoteServer } from "./remote-clients.ts";

function completionSignal() {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => complete() };
}

/** Real encryption with an explicit completion barrier; never an assertion about macOS Keychain. */
export class ControlledProtection implements CredentialProtection {
  private readonly key = randomBytes(32);
  readonly started = completionSignal();
  readonly completion = completionSignal();

  constructor(
    private readonly delayed = false,
    private readonly available = true,
  ) {}

  async isAsyncEncryptionAvailable() {
    return this.available;
  }

  async encryptStringAsync(plaintext: string): Promise<Buffer> {
    this.started.resolve();
    if (this.delayed) await this.completion.promise;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  async decryptStringAsync(encrypted: Buffer) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    return {
      result: Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
        "utf8",
      ),
    };
  }
}

export async function desktopProfile(
  context: TestContext,
  protection = new ControlledProtection(),
) {
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-desktop-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = await SettingsStore.open(directory);
  await store.update({ role: "client" });
  const client = await ApprovedClient.open(store, protection);
  context.onTestFinished(() => client.close());
  return {
    client,
    store,
    directory,
    protection,
    async reopen() {
      client.close();
      const restored = await ApprovedClient.open(await SettingsStore.open(directory), protection);
      context.onTestFinished(() => restored.close());
      return restored;
    },
  };
}

export const remoteAddress = (server: Awaited<ReturnType<typeof remoteServer>>) =>
  `https://127.0.0.1:${server.server.remoteAddress()!.port}`;

export async function selectServer(
  client: ApprovedClient,
  server: Awaited<ReturnType<typeof remoteServer>>,
) {
  const probe = await client.probe(remoteAddress(server));
  await client.connect(probe.url, probe.fingerprint);
  return probe;
}

export function desktopRelay(client: ApprovedClient) {
  const relay = factoryProtocolHandler({
    uiDirectory: ".",
    target: () => {
      const connection = client.capture();
      return connection ? { kind: "remote", connection } : null;
    },
  });
  return (path: string, init?: RequestInit) =>
    relay(
      new Request(`factory://app${path}`, {
        ...init,
        headers: {
          "x-factory-protocol": String(FACTORY_PROTOCOL),
          "x-factory-protocol-minimum": String(FACTORY_MINIMUM_SERVER_PROTOCOL),
          "x-factory-request": "1",
          "content-type": "application/json",
        },
      }),
    );
}

export const requestDesktopAccess = (client: ApprovedClient) =>
  desktopRelay(client)("/api/client-access/requests", {
    method: "POST",
    body: JSON.stringify({ label: "Desktop", kind: "desktop" }),
  });

export async function pendingCredential(context: TestContext): Promise<
  Awaited<ReturnType<typeof desktopProfile>> & {
    server: Awaited<ReturnType<typeof remoteServer>>;
    reply: Promise<Response>;
  }
> {
  const server = await remoteServer(context);
  const profile = await desktopProfile(context, new ControlledProtection(true));
  await selectServer(profile.client, server);
  const reply = requestDesktopAccess(profile.client);
  await profile.protection.started.promise;
  return { ...profile, server, reply };
}

export function currentConnection(client: ApprovedClient) {
  const connection = client.capture();
  assert(connection);
  return connection;
}

export async function readDesktopAccess(client: ApprovedClient) {
  const response = await desktopRelay(client)("/api/client-access");
  const result = (await response.json()) as Result<ClientScope>;
  assert(result.ok);
  assert(result.value.scope === "remote");
  return result.value.access;
}

/** Real pinned TLS with a response held until the client disposes its active connection. */
export async function heldDesktopServer(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-held-desktop-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const certificate = await ensureRemoteCertificate(directory, { dns: [], ips: ["127.0.0.1"] });
  const received = completionSignal();
  const closed = completionSignal();
  const server = createServer(certificate, (request, response) => {
    if (request.url === "/api/protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, value: { protocol: FACTORY_PROTOCOL } }));
    } else {
      response.once("close", () => closed.resolve());
      received.resolve();
    }
  });
  context.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `https://127.0.0.1:${address.port}`,
    received: received.promise,
    closed: closed.promise,
  };
}

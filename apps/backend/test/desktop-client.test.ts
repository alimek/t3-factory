import { assert, expect, it } from "@effect/vitest";
import type { FactoryClient, Result } from "@t3-factory/contracts";
import { SettingsStore } from "../../desktop/src/settings-store.ts";
import {
  ControlledProtection,
  currentConnection,
  heldDesktopServer,
  desktopProfile,
  desktopRelay,
  pendingCredential,
  remoteAddress,
  requestDesktopAccess,
  readDesktopAccess,
  selectServer,
} from "./support/desktop-client.ts";
import { remoteServer } from "./support/remote-clients.ts";

it("a captured request cannot send to the old server after the selection changes", async (c) => {
  // Arrange
  const a = await remoteServer(c);
  const b = await remoteServer(c);
  const { client, store } = await desktopProfile(c);
  await selectServer(client, a);
  const upload = new TransformStream<Uint8Array, Uint8Array>();
  const writer = upload.writable.getWriter();
  const relay = desktopRelay(client);

  // Act
  const reply = relay("/api/client-access/requests", {
    method: "POST",
    body: upload.readable,
    duplex: "half",
  });
  await selectServer(client, b);
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ label: "Old request", kind: "desktop" })),
  );
  await writer.close();
  const response = await reply;

  // Assert
  expect(response.status).toBe(503);
  expect(store.get().server?.url).toBe(remoteAddress(b));
  expect(store.get().server?.credential).toBeNull();
  expect(await a.factory.listClients()).toStrictEqual({ ok: true, value: [] });
  expect(await b.factory.listClients()).toStrictEqual({ ok: true, value: [] });
});

it("completed encryption cannot restore the previous server after selecting another", async (c) => {
  // Arrange
  const { client, store, directory, protection, reply } = await pendingCredential(c);
  const b = await remoteServer(c);

  // Act
  await selectServer(client, b);
  protection.completion.resolve();
  const response = await reply;

  // Assert
  expect(response.status).toBe(503);
  expect(store.get().server?.url).toBe(remoteAddress(b));
  expect(store.get().server?.credential).toBeNull();
  expect((await SettingsStore.open(directory)).get()).toStrictEqual(store.get());
  const access = await readDesktopAccess(client);
  expect(access.status).toBe("none");
});

it("forgetting a server stays forgotten when pending encryption completes", async (c) => {
  // Arrange
  const { client, store, directory, protection, reply } = await pendingCredential(c);

  // Act
  await client.forget();
  protection.completion.resolve();
  const response = await reply;

  // Assert
  expect(response.status).toBe(503);
  expect(client.capture()).toBeNull();
  expect(store.get().server).toBeNull();
  expect((await SettingsStore.open(directory)).get().server).toBeNull();
});

it("switching to server role rejects a pending client credential without deleting remembered trust", async (c) => {
  // Arrange
  const { client, store, server, protection, reply } = await pendingCredential(c);

  // Act
  await client.chooseRole("server");
  protection.completion.resolve();
  const response = await reply;

  // Assert
  expect(response.status).toBe(503);
  expect(client.capture()).toBeNull();
  expect(store.get().role).toBe("server");
  expect(store.get().server?.url).toBe(remoteAddress(server));
  expect(store.get().server?.credential).toBeNull();
});

it("reselecting the same server does not revive an earlier request identity", async (c) => {
  // Arrange
  const { client, store, server, protection, reply } = await pendingCredential(c);

  // Act
  await selectServer(client, server);
  protection.completion.resolve();
  const response = await reply;

  // Assert
  expect(response.status).toBe(503);
  expect(store.get().server?.credential).toBeNull();
  const access = await readDesktopAccess(client);
  expect(access.status).toBe("none");
});

it("an approved desktop credential survives a restart encrypted and never reaches the renderer", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const profile = await desktopProfile(c);
  await selectServer(profile.client, server);
  const response = await requestDesktopAccess(profile.client);
  const body = (await response.json()) as Result<{ client: FactoryClient; credential: string }>;
  assert(body.ok);
  assert((await server.factory.approveClient(body.value.client.id)).ok);
  const encrypted = profile.store.get().server?.credential;
  assert(encrypted);
  const issued = await profile.protection.decryptStringAsync(Buffer.from(encrypted, "base64"));

  // Act
  const restored = await profile.reopen();

  // Assert
  expect(body.value.credential).toBe("");
  expect(Buffer.from(encrypted, "base64").includes(Buffer.from(issued.result))).toBe(false);
  const access = await readDesktopAccess(restored);
  expect(access.status).toBe("approved");
});

it("without Keychain a desktop credential authorizes only the current session", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const profile = await desktopProfile(c, new ControlledProtection(false, false));
  await selectServer(profile.client, server);
  const response = await requestDesktopAccess(profile.client);
  const body = (await response.json()) as Result<{ client: FactoryClient; credential: string }>;
  assert(body.ok);
  assert((await server.factory.approveClient(body.value.client.id)).ok);
  const active = await readDesktopAccess(profile.client);
  expect(active.status).toBe("approved");

  // Act
  const restored = await profile.reopen();

  // Assert
  expect(body.value.credential).toBe("");
  expect(profile.store.get().server?.credential).toBeNull();
  const access = await readDesktopAccess(restored);
  expect(access.status).toBe("none");
});

it("a trust confirmation must match the probed address and fingerprint", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const { client, store } = await desktopProfile(c);
  const probe = await client.probe(remoteAddress(server));

  // Act
  const connected = client.connect(probe.url, "another fingerprint");

  // Assert
  await expect(connected).rejects.toThrow("Check the server again");
  expect(store.get().server).toBeNull();
  expect(client.capture()).toBeNull();
});

it("forgetting a server invalidates already captured credential callbacks", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const { client } = await desktopProfile(c);
  await selectServer(client, server);
  const captured = currentConnection(client);
  await client.forget();

  // Act
  const remembered = captured.rememberCredential("obsolete-fixture-credential");

  // Assert
  await expect(remembered).rejects.toThrow("selected Factory server changed");
  expect(client.capture()).toBeNull();
});

it("returning to client role restores the approved credential for the same remembered server", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const { client, store } = await desktopProfile(c);
  await selectServer(client, server);
  const response = await requestDesktopAccess(client);
  const body = (await response.json()) as Result<{ client: FactoryClient }>;
  assert(body.ok);
  assert((await server.factory.approveClient(body.value.client.id)).ok);
  const remembered = store.get().server;
  await client.chooseRole("server");
  expect(client.capture()).toBeNull();

  // Act
  await client.chooseRole("client");

  // Assert
  expect(store.get().server).toStrictEqual(remembered);
  expect((await readDesktopAccess(client)).status).toBe("approved");
});

it("forgetting a server closes an active TLS request and prevents its response from being used", async (c) => {
  // Arrange
  const server = await heldDesktopServer(c);
  const { client, store } = await desktopProfile(c);
  const probe = await client.probe(server.url);
  await client.connect(probe.url, probe.fingerprint);
  const reply = requestDesktopAccess(client);
  await server.received;

  // Act
  await client.forget();
  const response = await reply;
  await server.closed;

  // Assert
  expect(response.status).toBe(503);
  expect(store.get().server).toBeNull();
  expect(client.capture()).toBeNull();
});

it("saving a credential and a shell preference concurrently preserves both settings", async (c) => {
  // Arrange
  const { client, store, directory, protection, reply } = await pendingCredential(c);

  // Act
  protection.completion.resolve();
  const [response] = await Promise.all([reply, store.update({ launchAtLogin: true })]);

  // Assert
  expect(response.status).toBe(201);
  const persisted = (await SettingsStore.open(directory)).get();
  expect(persisted.launchAtLogin).toBe(true);
  expect(persisted.server?.credential).toBeTypeOf("string");
  expect((await readDesktopAccess(client)).status).toBe("pending");
});

import { assert, expect, it } from "@effect/vitest";
import type { FactoryClient, FlowDraft, RunDetail } from "@t3-factory/contracts";
import { remotePrepared, remoteServer } from "./support/remote-clients.ts";
import { imageStart, screenshots, sha256Hex, stageImages } from "./support/run-images.ts";

it("a remote read without an approved credential is refused before any operation", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  assert((await server.factory.createFlow({ name: "Private plan" })).ok);
  const stranger = server.client();

  // Act
  const reply = await stranger.send("GET", "/api/flows");

  // Assert
  expect(reply.status).toBe(401);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("unauthorized");
});

it("a pending client's mutation is refused and changes nothing", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const pending = server.client();
  await pending.requestAccess("Laptop");

  // Act
  const reply = await pending.send("POST", "/api/flows", { name: "Sneaky" });

  // Assert
  expect(reply.status).toBe(401);
  expect(await server.factory.listFlows()).toStrictEqual({ ok: true, value: [] });
});

it("a host-approved client operates the host's authoritative state", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const created = await server.factory.createFlow({ name: "Shared plan" });
  assert(created.ok);

  // Act
  const reply = await laptop.send<readonly FlowDraft[]>("GET", "/api/flows");

  // Assert
  assert(reply.body.ok);
  expect(reply.body.value.map((flow) => flow.id)).toStrictEqual([created.value.id]);
});

it("a denied client's credential never grants access", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = server.client();
  const requested = await laptop.requestAccess("Unknown laptop");

  // Act
  const denied = await server.host<FactoryClient>("POST", `/api/host/clients/${requested.id}/deny`);

  // Assert
  assert(denied.body.ok);
  expect(denied.body.value.status).toBe("denied");
  expect((await laptop.send("GET", "/api/flows")).status).toBe(401);
});

it("revoking one client ends its existing session while another approved client continues", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const browser = await server.approved("Browser profile", "browser");
  assert((await laptop.send("GET", "/api/flows")).body.ok);

  // Act
  const revoked = await server.host<FactoryClient>("POST", `/api/host/clients/${laptop.id}/revoke`);

  // Assert
  assert(revoked.body.ok);
  const afterRevocation = await laptop.send("GET", "/api/flows");
  expect(afterRevocation.status).toBe(401);
  assert(!afterRevocation.body.ok);
  expect(afterRevocation.body.error.message).toMatch(/revoked/);
  expect((await browser.send("GET", "/api/flows")).status).toBe(200);
});

it("an approved client cannot change host T3 setup or submit runtime reports", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send("POST", "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "factory_update_block",
      arguments: { to: "finished" },
      _meta: { callId: "remote-call" },
    },
  });

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
});

it("a cross-site browser mutation is refused even with an approved cookie", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const browser = await server.approved("Browser profile", "browser");

  // Act
  const reply = await browser.send(
    "POST",
    "/api/flows",
    { name: "Cross-site" },
    { origin: "https://attacker.example" },
  );

  // Assert
  expect(reply.status).toBe(403);
  expect(await server.factory.listFlows()).toStrictEqual({ ok: true, value: [] });
});

it("browser approval keeps the secret in an HttpOnly cookie instead of the response body", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const browser = server.client("browser");

  // Act
  const reply = await browser.send<{ credential: string }>("POST", "/api/client-access/requests", {
    label: "Browser profile",
    kind: "browser",
  });

  // Assert
  assert(reply.body.ok);
  expect(reply.body.value.credential).toBe("");
  expect(String(reply.headers["set-cookie"])).toMatch(
    /^factory_client=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/,
  );
});

it("a client label is never treated as an approved identity", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  await server.approved("Laptop");
  const impostor = server.client();
  await impostor.requestAccess("Laptop");

  // Act
  const reply = await impostor.send("GET", "/api/flows");

  // Assert
  expect(reply.status).toBe(401);
});

it("a denied access request cannot later be approved", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = server.client();
  const requested = await laptop.requestAccess("Denied laptop");
  assert((await server.host("POST", `/api/host/clients/${requested.id}/deny`)).body.ok);

  // Act
  const approved = await server.host("POST", `/api/host/clients/${requested.id}/approve`);

  // Assert
  expect(approved.status).toBe(409);
  expect((await laptop.send("GET", "/api/flows")).status).toBe(401);
});

it("an approved client uploads images and starts a Run with them over the secure listener", async (c) => {
  // Arrange
  const { server, laptop, input } = await remotePrepared(c);
  const request = imageStart(input);
  const uploads = await Promise.all(
    Object.values(screenshots).map((image) =>
      laptop.sendBytes("PUT", `/api/run-images/${sha256Hex(image.data)}`, {
        contentType: "image/png",
        data: image.data,
      }),
    ),
  );

  // Act
  const reply = await laptop.send<RunDetail>("POST", "/api/runs", request);

  // Assert
  expect(uploads.map((upload) => upload.status)).toStrictEqual([200, 200, 200]);
  expect(reply.status).toBe(201);
  const runs = await server.factory.listRuns(input.projectId);
  assert(runs.ok && reply.body.ok);
  expect(runs.value.map((run) => run.id)).toStrictEqual([reply.body.value.id]);
});

it("an approved client's image load returns the original bytes with immutable caching", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  await stageImages(server.factory, [screenshots.green]);

  // Act
  const image = await laptop.asset(`/api/run-images/${sha256Hex(screenshots.green.data)}`);

  // Assert
  expect(image.status).toBe(200);
  expect(image.contentType).toBe("image/png");
  expect(image.data.equals(Buffer.from(screenshots.green.data))).toBe(true);
});

it("a pending client cannot even probe whether Factory holds a known image", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  await stageImages(server.factory, [screenshots.green]);
  const pending = server.client();
  await pending.requestAccess("Laptop");

  // Act
  const probe = await pending.sendBytes("HEAD", `/api/run-images/${sha256Hex(screenshots.green.data)}`);

  // Assert
  expect(probe.status).toBe(401);
});

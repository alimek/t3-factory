import { assert, expect, it } from "@effect/vitest";
import type { T3Connection } from "@t3-factory/contracts";
import { remoteConnection } from "./support/remote-clients.ts";

const openAuthorization = "/api/connection/authorization/open";

it("an approved client opens authorization in the host browser for the host's saved endpoint", async (c) => {
  // Arrange
  const { laptop, t3 } = await remoteConnection(c);

  // Act
  const reply = await laptop.send<T3Connection>("POST", openAuthorization);

  // Assert
  assert(reply.body.ok);
  expect(reply.body.value.state).toBe("authorization-required");
  expect(reply.body.value.authorizationPending).toBe(true);
  expect(reply.body.value.endpoint).toBe("https://t3.example/mcp");
  expect(t3.authorizationStarts).toBe(1);
});

it("opening authorization again within the cooldown does not open the host browser again", async (c) => {
  // Arrange
  const { laptop, t3 } = await remoteConnection(c);
  assert((await laptop.send("POST", openAuthorization)).body.ok);

  // Act
  const reply = await laptop.send<T3Connection>("POST", openAuthorization);

  // Assert
  assert(reply.body.ok);
  expect(reply.body.value.authorizationPending).toBe(true);
  expect(t3.authorizationStarts).toBe(1);
  expect(t3.reopenedApprovals).toBe(0);
});

it("a revoked client cannot open authorization on the host", async (c) => {
  // Arrange
  const { server, laptop, t3 } = await remoteConnection(c);
  assert((await server.host("POST", `/api/host/clients/${laptop.id}/revoke`)).body.ok);

  // Act
  const reply = await laptop.send("POST", openAuthorization);

  // Assert
  expect(reply.status).toBe(401);
  expect(t3.authorizationStarts).toBe(0);
});

it("a client still waiting for host approval cannot open authorization on the host", async (c) => {
  // Arrange
  const { server, t3 } = await remoteConnection(c);
  const waiting = server.client();
  await waiting.requestAccess("Unapproved laptop");

  // Act
  const reply = await waiting.send("POST", openAuthorization);

  // Assert
  expect(reply.status).toBe(401);
  expect(t3.authorizationStarts).toBe(0);
});

it("an approved client cannot change the host's saved T3 endpoint", async (c) => {
  // Arrange
  const { server, laptop } = await remoteConnection(c);

  // Act
  const reply = await laptop.send("PUT", "/api/connection", {
    endpoint: "https://elsewhere.example/mcp",
  });

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  const connection = await server.factory.getConnection();
  assert(connection.ok);
  expect(connection.value.endpoint).toBe("https://t3.example/mcp");
});

it("an approved client cannot reauthorize and replace the host's ready grant", async (c) => {
  // Arrange
  const { server, laptop, t3 } = await remoteConnection(c);
  t3.approve();
  const ready = await server.factory.recheckConnection();
  assert(ready.ok);

  // Act
  const reply = await laptop.send("POST", "/api/connection/authorize");

  // Assert
  expect(reply.status).toBe(403);
  const connection = await server.factory.getConnection();
  assert(connection.ok);
  expect(connection.value.authorizationContext).toStrictEqual(ready.value.authorizationContext);
  expect(t3.authorizationStarts).toBe(0);
});

it("an approved client cannot pair theme colors with the host's T3", async (c) => {
  // Arrange
  const { laptop, t3 } = await remoteConnection(c);

  // Act
  const reply = await laptop.send("POST", "/api/connection/appearance", {
    pairing: t3.appearance.pairingCode,
  });

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(t3.appearance.pairings).toBe(0);
});

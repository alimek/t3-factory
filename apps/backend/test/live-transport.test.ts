import { assert, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import { FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import { liveClient, refusedUpgrade, subscribe } from "./support/live.ts";
import { remoteServer } from "./support/remote-clients.ts";

it("a live connection from another site's Origin is refused before the upgrade", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const host = server.hostLive();

  // Act
  const status = await refusedUpgrade({
    ...host,
    headers: { origin: "https://attacker.example" },
  });

  // Assert
  expect(status).toBe(403);
});

it("a live connection declaring an incompatible protocol is refused with 426 before the upgrade", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const newer = { protocol: FACTORY_PROTOCOL + 1, minimum: FACTORY_PROTOCOL + 1 };

  // Act
  const status = await refusedUpgrade(server.hostLive(newer));

  // Assert
  expect(status).toBe(426);
});

it("a remote live connection without an approved credential is refused with 401 before the upgrade", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const stranger = server.client();

  // Act
  const status = await refusedUpgrade(stranger.live());

  // Assert
  expect(status).toBe(401);
});

it("revoking an approved client ends its open live stream", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const live = subscribe(c, (await liveClient(c, laptop.live())).WatchConnection());
  await live.until((messages) => messages.length > 0);

  // Act
  const revoked = await server.host("POST", `/api/host/clients/${laptop.id}/revoke`);

  // Assert
  assert(revoked.body.ok);
  const ended = await live.ended;
  expect(Exit.isFailure(ended)).toBe(true);
  expect(live.messages.map((message) => message._tag)).toStrictEqual(["snapshot"]);
});

it("disabling remote access ends approved clients' open live streams", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const live = subscribe(c, (await liveClient(c, laptop.live())).WatchConnection());
  await live.until((messages) => messages.length > 0);

  // Act
  const disabled = await server.host("PUT", "/api/host/remote-access", { enabled: false });

  // Assert
  assert(disabled.body.ok);
  expect(Exit.isFailure(await live.ended)).toBe(true);
});

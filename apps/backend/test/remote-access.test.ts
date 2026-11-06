import { assert, expect, it } from "@effect/vitest";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { remoteServer } from "./support/remote-clients.ts";

/** This machine's own LAN or tailnet address: a non-loopback socket peer without a second device. */
const ownNetworkAddress = () => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((candidate) => candidate && !candidate.internal && candidate.family === "IPv4");
  assert(address, "The host-surface test needs one non-loopback IPv4 interface.");
  return address.address;
};

it("the host-local listener refuses requests arriving from a network address", async (c) => {
  // Arrange
  const server = await remoteServer(c, { host: "0.0.0.0" });
  const address = ownNetworkAddress();

  // Act
  const response = await fetch(`http://${address}:${server.server.address.port}/api/flows`);

  // Assert
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("host_only");
});

it("disabling remote access closes approved clients' existing sessions", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  assert((await laptop.send("GET", "/api/flows")).body.ok);

  // Act
  const reply = await server.host("PUT", "/api/host/remote-access", { enabled: false });

  // Assert
  assert(reply.body.ok);
  await expect(laptop.send("GET", "/api/flows")).rejects.toThrow();
});

it("starting secure remote access keeps the host's private keys in owner-only storage", async (c) => {
  // Arrange
  const keyPath = (home: string, name: string) => join(home, "credentials", "tls", name);

  // Act
  const server = await remoteServer(c);

  // Assert
  const authority = await stat(keyPath(server.home, "ca-key.pem"));
  const leaf = await stat(keyPath(server.home, "server-key.pem"));
  expect([authority.mode & 0o777, leaf.mode & 0o777]).toStrictEqual([0o600, 0o600]);
  expect((await stat(join(server.home, "credentials", "tls"))).mode & 0o777).toBe(0o700);
});

it("a browser can download the host certificate before negotiating a product protocol", async (c) => {
  // Arrange
  const server = await remoteServer(c);

  // Act
  const response = await server.downloadCertificate();

  // Assert
  expect(response.status).toBe(200);
  expect(response.text).toBe(server.trustAnchor());
});

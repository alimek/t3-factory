import { expect, it, type TestContext } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguration } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { hostStatus } from "./support/boundaries-setup.ts";
import { ControlledT3 } from "./support/controlled-t3.ts";

async function startConnectionServer(c: TestContext, t3: ControlledT3) {
  const directory = await mkdtemp(join(tmpdir(), "factory-connection-http-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer(
    await loadConfiguration({ FACTORY_HOME: directory, FACTORY_PORT: "0" }),
    { t3 },
  );
  c.onTestFinished(() => server.close());
  return { server, base: `http://127.0.0.1:${server.address.port}` };
}

it("authorize rejects a cross-site POST without the factory request header", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  const { base, server } = await startConnectionServer(c, t3);
  await server.factory.configureConnection({ endpoint: "http://localhost:3773/mcp" });
  const before = await server.factory.getConnection();

  // Act
  const response = await fetch(`${base}/api/connection/authorize`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/x-www-form-urlencoded",
    },
  });

  // Assert
  expect(response.status).toBe(403);
  expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
  expect(response.headers.get("access-control-allow-origin")).toBe(null);
  expect(await server.factory.getConnection()).toStrictEqual(before);
  expect(t3.authorizationStarts).toBe(0);
});

it("authorize rejects an untrusted origin even with the factory request header", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  const { base, server } = await startConnectionServer(c, t3);
  await server.factory.configureConnection({ endpoint: "http://localhost:3773/mcp" });
  const before = await server.factory.getConnection();

  // Act
  const response = await fetch(`${base}/api/connection/authorize`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "x-factory-request": "1" },
  });

  // Assert
  expect(response.status).toBe(403);
  expect(await server.factory.getConnection()).toStrictEqual(before);
  expect(t3.authorizationStarts).toBe(0);
});

it("authorize accepts a same-origin factory request and starts authorization once", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  const { base, server } = await startConnectionServer(c, t3);
  await server.factory.configureConnection({ endpoint: "http://localhost:3773/mcp" });

  // Act
  const response = await fetch(`${base}/api/connection/authorize`, {
    method: "POST",
    headers: { origin: base, "x-factory-request": "1" },
  });

  // Assert
  expect(response.status).toBe(200);
  expect(t3.authorizationStarts).toBe(1);
});

it("HTTP rejects hostile Host headers", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  const { base, server } = await startConnectionServer(c, t3);

  // Act
  const rootStatus = await hostStatus(base + "/", `evil.example:${server.address.port}`);

  // Assert
  expect(rootStatus).toBe(421);
});

it("Factory MCP refuses a cross-origin browser request", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  const { base } = await startConnectionServer(c, t3);

  // Act
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  // Assert
  expect(response.status).toBe(403);
});

it("authorize preflight from an untrusted origin is rejected without CORS allow headers", async (c) => {
  // Arrange
  const t3 = new ControlledT3();
  const { base } = await startConnectionServer(c, t3);

  // Act
  const preflight = await fetch(`${base}/api/connection/authorize`, {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-headers": "X-Factory-Request",
    },
  });

  // Assert
  expect(preflight.status).toBe(403);
  expect(preflight.headers.get("access-control-allow-headers")).toBe(null);
});

it("non-loopback binding accepts a configured tailnet DNS host", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "factory-allowed-host-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer(
    await loadConfiguration({
      FACTORY_HOME: directory,
      FACTORY_HOST: "0.0.0.0",
      FACTORY_PORT: "0",
      FACTORY_ALLOWED_HOSTS: "factory.tail.example, factory.lan",
    }),
    { t3: new ControlledT3() },
  );
  c.onTestFinished(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;

  // Act
  const tailStatus = await hostStatus(base, `factory.tail.example:${server.address.port}`);

  // Assert
  expect(tailStatus).toBe(200);
});

it("non-loopback binding rejects unconfigured DNS hosts", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "factory-allowed-host-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer(
    await loadConfiguration({
      FACTORY_HOME: directory,
      FACTORY_HOST: "0.0.0.0",
      FACTORY_PORT: "0",
      FACTORY_ALLOWED_HOSTS: "factory.tail.example, factory.lan",
    }),
    { t3: new ControlledT3() },
  );
  c.onTestFinished(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;

  // Act
  const attackerStatus = await hostStatus(base, `attacker.example:${server.address.port}`);

  // Assert
  expect(attackerStatus).toBe(421);
});

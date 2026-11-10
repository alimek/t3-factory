import { assert, expect, it } from "@effect/vitest";
import type { FlowDraft, Result } from "@t3-factory/contracts";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguration } from "../src/config.ts";
import { startServer } from "../src/server.ts";

it("foreground server binds to the configured host and serves the UI", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-server-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfiguration({
    FACTORY_HOME: directory,
    FACTORY_HOST: "0.0.0.0",
    FACTORY_PORT: "0",
  });
  const uiDirectory = join(directory, "ui");
  await mkdir(uiDirectory);
  await writeFile(join(uiDirectory, "index.html"), "<!doctype html><title>T3 Factory</title>");
  const server = await startServer(config, { uiDirectory });
  c.onTestFinished(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;

  // Act
  const page = await fetch(base + "/flows");

  // Assert
  expect(server.address.address).toBe("0.0.0.0");
  expect(page.status).toBe(200);
  expect(await page.text()).toMatch(/T3 Factory/);
});

it("a saved Flow draft survives server restart", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-server-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfiguration({ FACTORY_HOME: directory, FACTORY_PORT: "0" });
  let server = await startServer(config, { uiDirectory: null });
  const base = `http://127.0.0.1:${server.address.port}`;
  const saved = await fetch(base + "/api/flows", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Factory-Request": "1" },
    body: JSON.stringify({ name: "Restart smoke" }),
  });
  expect(saved.status).toBe(201);
  const body = (await saved.json()) as Result<FlowDraft>;
  assert(body.ok);
  await server.close();
  server = await startServer(config, { uiDirectory: null });
  c.onTestFinished(() => server.close());
  const recoveredUrl = `http://127.0.0.1:${server.address.port}/api/flows/${body.value.id}`;

  // Act
  const recovered = await fetch(recoveredUrl);

  // Assert
  const result = (await recovered.json()) as Result<FlowDraft>;
  assert(result.ok);
  expect(result.value.name).toBe("Restart smoke");
});

it("first server start persists loopback host in config and creates restricted credentials directory", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-server-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfiguration({
    FACTORY_HOME: directory,
    FACTORY_HOST: "0.0.0.0",
    FACTORY_PORT: "0",
  });

  // Act
  const server = await startServer(config, { uiDirectory: null });

  // Assert
  c.onTestFinished(() => server.close());
  const persisted = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  const credentialsMode = (await stat(join(directory, "credentials"))).mode & 0o777;

  expect(persisted.host).toBe("127.0.0.1");
  expect(credentialsMode).toBe(0o700);
});

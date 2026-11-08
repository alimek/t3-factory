import { assert, expect, it } from "@effect/vitest";
import type { FlowDraft, RunDetail } from "@t3-factory/contracts";
import { remotePrepared, remoteServer } from "./support/remote-clients.ts";

it("a Start whose response was lost resolves to the original Run when the client retries it", async (c) => {
  // Arrange
  const { server, laptop, input } = await remotePrepared(c);
  await laptop.sendLosingResponse("POST", "/api/runs", input);

  // Act
  const retried = await laptop.send<RunDetail>("POST", "/api/runs", input);

  // Assert
  assert(retried.body.ok);
  const runs = await server.factory.listRuns(input.projectId);
  assert(runs.ok);
  expect(runs.value.map((run) => run.id)).toStrictEqual([retried.body.value.id]);
});

it("concurrent edits from two approved clients keep revision conflicts", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const browser = await server.approved("Browser profile", "browser");
  const created = await server.factory.createFlow({ name: "Shared plan" });
  assert(created.ok);
  const edit = (name: string) => ({ name, expectedRevision: 1, graph: created.value.graph });
  assert((await laptop.send("PUT", `/api/flows/${created.value.id}`, edit("Laptop edit"))).body.ok);

  // Act
  const reply = await browser.send("PUT", `/api/flows/${created.value.id}`, edit("Browser edit"));

  // Assert
  expect(reply.status).toBe(409);
  const saved = await server.factory.getFlow(created.value.id);
  assert(saved.ok);
  expect(saved.value.name).toBe("Laptop edit");
});

it("a protocol 3 client saving a Flow without a workspace keeps the saved workspace", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const older = await server.approved("Laptop", "desktop", { protocol: 3, minimum: 3 });
  const created = await server.factory.createFlow({ name: "Shared plan" });
  assert(created.ok);
  const checkout = await server.factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: 1,
    workspace: { mode: "checkout" },
    graph: created.value.graph,
  });
  assert(checkout.ok);

  // Act
  const reply = await older.send("PUT", `/api/flows/${created.value.id}`, {
    name: "Laptop edit",
    expectedRevision: 2,
    graph: created.value.graph,
  });

  // Assert
  expect(reply.status).toBe(200);
  expect(await server.factory.getFlow(created.value.id)).toMatchObject({
    ok: true,
    value: { revision: 3, name: "Laptop edit", workspace: { mode: "checkout" } },
  });
});

it("a client older than the server's supported protocol is told to update itself", async (c) => {
  // Arrange
  const server = await remoteServer(c, { protocol: { protocol: 3, minimumPeerProtocol: 2 } });
  const old = server.client("desktop", { protocol: 1, minimum: 1 });

  // Act
  const reply = await old.send("GET", "/api/flows");

  // Assert
  expect(reply.status).toBe(426);
  assert(!reply.body.ok);
  expect(reply.body.error.message).toMatch(/Update this client/);
});

it("the current client refuses a protocol-one server before product access", async (c) => {
  // Arrange
  const server = await remoteServer(c, { protocol: { protocol: 1, minimumPeerProtocol: 1 } });
  const current = server.client();

  // Act
  const reply = await current.send("GET", "/api/projects");

  // Assert
  expect(reply.status).toBe(426);
  assert(!reply.body.ok);
  expect(reply.body.error.message).toMatch(/Update the Factory server/);
});

it("a previously approved protocol-one client retains read access on the current server", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const old = await server.approved("Retained browser", "browser", { protocol: 1, minimum: 1 });

  // Act
  const reply = await old.send<readonly FlowDraft[]>("GET", "/api/flows");

  // Assert
  expect(reply.status).toBe(200);
  expect(reply.body).toStrictEqual({ ok: true, value: [] });
});

import { assert, expect, it } from "@effect/vitest";
import { remoteServer } from "./support/remote-clients.ts";

it("an approved client loads a T3 icon absent from the interface imports", async (context) => {
  // Arrange
  const server = await remoteServer(context);
  const client = await server.approved("Icon client");

  // Act
  const response = await client.send<{ name: string; node: unknown[] }>(
    "GET",
    "/api/icons/lucide/a-arrow-down",
  );

  // Assert
  expect(response.status).toBe(200);
  assert(response.body.ok);
  expect(response.body.value.name).toBe("a-arrow-down");
  expect(response.body.value.node).toHaveLength(4);
});

it("a T3 icon alias retains its original geometry", async (context) => {
  // Arrange
  const server = await remoteServer(context);
  const client = await server.approved("Alias client");

  // Act
  const response = await client.send<{ name: string; node: unknown[] }>(
    "GET",
    "/api/icons/lucide/circle-help",
  );

  // Assert
  expect(response.status).toBe(200);
  assert(response.body.ok);
  expect(response.body.value.name).toBe("circle-question-mark");
  expect(response.body.value.node[0]).toStrictEqual([
    "circle",
    { cx: "12", cy: "12", r: "10", key: "1mglay" },
  ]);
});

it("an inherited property cannot be loaded as a project icon", async (context) => {
  // Arrange
  const server = await remoteServer(context);
  const client = await server.approved("Unknown icon client");

  // Act
  const response = await client.send("GET", "/api/icons/lucide/constructor");

  // Assert
  expect(response.status).toBe(404);
  assert(!response.body.ok);
  expect(response.body.error.code).toBe("not_found");
});

it("a revoked client cannot load project icon data", async (context) => {
  // Arrange
  const server = await remoteServer(context);
  const client = await server.approved("Revoked icon client");
  assert((await server.host("POST", `/api/host/clients/${client.id}/revoke`)).body.ok);

  // Act
  const response = await client.send("GET", "/api/icons/lucide/folder");

  // Assert
  expect(response.status).toBe(401);
});

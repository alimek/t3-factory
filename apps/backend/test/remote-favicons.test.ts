import { assert, expect, it } from "@effect/vitest";
import { remoteFavicon, tinyPng } from "./support/project-favicons.ts";
import { FACTORY_PROTOCOL } from "@t3-factory/domain-validation";

it("ordinary product API requests still require a protocol declaration", async (context) => {
  // Arrange
  const { server } = await remoteFavicon(context);
  const client = await server.approved("Desktop");

  // Act
  const response = await client.asset("/api/projects");

  // Assert
  expect(response.status).toBe(426);
});

it("an approved desktop loads a project image without application protocol headers", async (context) => {
  // Arrange
  const { server, path } = await remoteFavicon(context);
  const client = await server.approved("Desktop");

  // Act
  const image = await client.asset(path);

  // Assert
  expect(image.status).toBe(200);
  expect(image.contentType).toBe("image/png");
  expect(image.data).toStrictEqual(tinyPng);
});

it("a revoked device cannot read project image bytes", async (context) => {
  // Arrange
  const { server, path } = await remoteFavicon(context);
  const client = await server.approved("Revoked desktop");
  assert((await server.host("POST", `/api/host/clients/${client.id}/revoke`)).body.ok);

  // Act
  const image = await client.asset(path);

  // Assert
  expect(image.status).toBe(401);
});

it("an unauthenticated image request cannot read repository files", async (context) => {
  // Arrange
  const { server, path } = await remoteFavicon(context);
  const client = server.client();

  // Act
  const image = await client.asset(path);

  // Assert
  expect(image.status).toBe(401);
});

it("a favicon request declaring an incompatible protocol is still rejected", async (context) => {
  // Arrange
  const { server, path } = await remoteFavicon(context);
  const client = await server.approved("Desktop");

  // Act
  const image = await client.asset(path, "GET", {
    "x-factory-protocol": String(FACTORY_PROTOCOL + 1),
    "x-factory-protocol-minimum": String(FACTORY_PROTOCOL + 1),
  });

  // Assert
  expect(image.status).toBe(426);
});

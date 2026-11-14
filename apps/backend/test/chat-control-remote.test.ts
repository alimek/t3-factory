import { assert, expect, it } from "@effect/vitest";
import { remoteServer } from "./support/remote-clients.ts";
import { chatModelSave, savedChatModel } from "./support/chat-control.ts";

it("an approved client cannot read the host's Chat control model settings", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  await savedChatModel(server.factory, { baseUrl: "https://private-gateway.example/v1" });
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send("GET", "/api/chat-control/model");

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(JSON.stringify(reply.body)).not.toContain("private-gateway");
});

it("an approved client cannot change the host's Chat control model settings", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const before = await server.factory.getChatModelSettings();
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send("PUT", "/api/chat-control/model", chatModelSave());

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(await server.factory.getChatModelSettings()).toStrictEqual(before);
});

it("an approved client cannot run the host's Chat control model Test", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const saved = await savedChatModel(server.factory);
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send("POST", "/api/chat-control/model/test", {
    revision: saved.configuration.revision,
  });

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(await server.factory.getChatModelSettings()).toStrictEqual({ ok: true, value: saved });
});

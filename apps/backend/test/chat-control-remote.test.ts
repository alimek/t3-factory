import { assert, expect, it } from "@effect/vitest";
import { remoteServer } from "./support/remote-clients.ts";
import { controlledDiscord } from "./support/controlled-discord.ts";
import {
  chatModelSave,
  discordBot,
  discordConnectionSave,
  savedChatModel,
  savedDiscordConnection,
} from "./support/chat-control.ts";

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

it("an approved client cannot read the host's Discord connection", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  await savedDiscordConnection(server.factory);
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send("GET", "/api/chat-control/discord");

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(JSON.stringify(reply.body)).not.toContain(discordBot.applicationId);
});

it("an approved client cannot change the host's Discord connection", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const before = await server.factory.getDiscordSettings();
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send(
    "PUT",
    "/api/chat-control/discord/connection",
    discordConnectionSave(),
  );

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(await server.factory.getDiscordSettings()).toStrictEqual(before);
});

it("an approved client cannot make the host connect to Discord", async (c) => {
  // Arrange
  const discord = await controlledDiscord(c);
  discord.addBot(discordBot);
  const server = await remoteServer(c, { discordApiUrl: discord.apiUrl });
  const saved = await savedDiscordConnection(server.factory);
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send("POST", "/api/chat-control/discord/check", {
    revision: saved.configuration.revision,
  });

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(discord.requests).toHaveLength(0);
});

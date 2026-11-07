import { assert, expect, it } from "@effect/vitest";
import type { ServerUpdate } from "@t3-factory/contracts";
import { recordingUpdates, remoteServer } from "./support/remote-clients.ts";

it("an approved client's install request reaches the server's updater", async (c) => {
  // Arrange
  const { actions, updates } = recordingUpdates();
  const server = await remoteServer(c, { applicationUpdates: updates });
  const laptop = await server.approved("Laptop");

  // Act
  const reply = await laptop.send<ServerUpdate>("POST", "/api/server-update/install");

  // Assert
  assert(reply.body.ok);
  expect(reply.body.value.update.state).toBe("downloaded");
  expect(actions).toStrictEqual(["install"]);
});

it("a client awaiting approval cannot restart the server into an update", async (c) => {
  // Arrange
  const { actions, updates } = recordingUpdates();
  const server = await remoteServer(c, { applicationUpdates: updates });
  const pending = server.client();
  await pending.requestAccess("Unknown laptop");

  // Act
  const reply = await pending.send("POST", "/api/server-update/install");

  // Assert
  expect(reply.status).toBe(401);
  expect(actions).toStrictEqual([]);
});

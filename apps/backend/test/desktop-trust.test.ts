import { expect, it, type TestContext } from "@effect/vitest";
import { ApprovedClient } from "../../desktop/src/approved-client.ts";
import {
  ControlledProtection,
  currentConnection,
  desktopProfile,
  selectServer,
} from "./support/desktop-client.ts";
import { openRemoteLive } from "./support/desktop-live.ts";
import { remoteServer, wrongHostnameServer } from "./support/remote-clients.ts";

/** A client that pinned the right authority for a server presenting another host's name. */
async function wrongHostnameClient(c: TestContext) {
  const { server, trust } = await wrongHostnameServer(c);
  const profile = await desktopProfile(c);
  await profile.store.update({
    server: {
      url: `https://127.0.0.1:${server.server.remoteAddress()!.port}`,
      trust,
      credential: null,
    },
  });
  const client = await ApprovedClient.open(profile.store, new ControlledProtection());
  c.onTestFinished(() => client.close());
  return client;
}

it("a desktop client refuses another host's certificate even when its authority is pinned", async (c) => {
  // Arrange
  const client = await wrongHostnameClient(c);

  // Act
  const response = currentConnection(client).request("GET", "/api/protocol", {}, undefined);

  // Assert
  await expect(response).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
});

it("a desktop client can negotiate with the selected host through its pinned authority", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const { client } = await desktopProfile(c);
  await selectServer(client, server);

  // Act
  const response = await currentConnection(client).request("GET", "/api/protocol", {}, undefined);

  // Assert
  expect(response.status).toBe(200);
});

it("a desktop live socket refuses another host's certificate even when its authority is pinned", async (c) => {
  // Arrange
  const client = await wrongHostnameClient(c);

  // Act
  const renderer = openRemoteLive(client);

  // Assert
  expect(await renderer.next("close")).toStrictEqual({
    type: "close",
    code: 1006,
    reason: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
  expect(renderer.received).toHaveLength(1);
});

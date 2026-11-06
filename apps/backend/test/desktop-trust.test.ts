import { expect, it } from "@effect/vitest";
import { ApprovedClient } from "../../desktop/src/approved-client.ts";
import {
  ControlledProtection,
  currentConnection,
  desktopProfile,
  selectServer,
} from "./support/desktop-client.ts";
import { remoteServer, wrongHostnameServer } from "./support/remote-clients.ts";

it("a desktop client refuses another host's certificate even when its authority is pinned", async (c) => {
  // Arrange
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

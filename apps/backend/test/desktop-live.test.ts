import { expect, it } from "@effect/vitest";
import { currentConnection, desktopProfile } from "./support/desktop-client.ts";
import { closed, liveQuery, liveServer, openRemoteLive } from "./support/desktop-live.ts";

it("the main process authorizes the desktop live socket without exposing the credential", async (c) => {
  // Arrange
  const live = await liveServer(c);
  const { client } = await desktopProfile(c);
  const probe = await client.probe(live.url);
  await client.connect(probe.url, probe.fingerprint);
  const credential = "fixture-client.fixture-secret";
  await currentConnection(client).rememberCredential(credential);

  // Act
  const renderer = openRemoteLive(client, `${liveQuery}&token=renderer-chosen`);
  await renderer.next("open");
  renderer.send({ type: "message", data: "ping" });
  const echoed = await renderer.next("message");

  // Assert
  expect(echoed.data).toBe("ping");
  expect(live.upgrades).toMatchObject([
    {
      url: `/api/live?${liveQuery}`,
      headers: { authorization: `Bearer ${credential}`, origin: live.url },
    },
  ]);
  expect(JSON.stringify(renderer.received)).not.toContain("fixture-secret");
});

it("selecting another server ends the live channel before an in-flight frame is delivered", async (c) => {
  // Arrange
  const a = await liveServer(c);
  const b = await liveServer(c);
  const { client } = await desktopProfile(c);
  const first = await client.probe(a.url);
  await client.connect(first.url, first.fingerprint);
  const renderer = openRemoteLive(client);
  await renderer.next("open");
  const old = await a.accepted();
  const next = await client.probe(b.url);

  // Act
  old.send("late");
  await client.connect(next.url, next.fingerprint);

  // Assert
  expect(await renderer.next("close")).toMatchObject({ code: 1006 });
  await closed(old);
  expect(renderer.received.filter((message) => message.type === "message")).toStrictEqual([]);
});

it("closing the renderer port closes the live socket", async (c) => {
  // Arrange
  const live = await liveServer(c);
  const { client } = await desktopProfile(c);
  const probe = await client.probe(live.url);
  await client.connect(probe.url, probe.fingerprint);
  const renderer = openRemoteLive(client);
  await renderer.next("open");
  const socket = await live.accepted();

  // Act
  renderer.send({ type: "close", code: 1000, reason: "hidden" });

  // Assert
  await closed(socket);
  expect(socket.readyState).toBe(socket.CLOSED);
});

it("an unauthorized live upgrade reaches the renderer as close code 4401", async (c) => {
  // Arrange
  const live = await liveServer(c, 401);
  const { client } = await desktopProfile(c);
  const probe = await client.probe(live.url);
  await client.connect(probe.url, probe.fingerprint);

  // Act
  const renderer = openRemoteLive(client);

  // Assert
  expect(await renderer.next("close")).toStrictEqual({
    type: "close",
    code: 4401,
    reason: "Unauthorized",
  });
});

it("an incompatible live upgrade reaches the renderer as close code 4426", async (c) => {
  // Arrange
  const live = await liveServer(c, 426);
  const { client } = await desktopProfile(c);
  const probe = await client.probe(live.url);
  await client.connect(probe.url, probe.fingerprint);

  // Act
  const renderer = openRemoteLive(client);

  // Assert
  expect(await renderer.next("close")).toStrictEqual({
    type: "close",
    code: 4426,
    reason: "Upgrade Required",
  });
});

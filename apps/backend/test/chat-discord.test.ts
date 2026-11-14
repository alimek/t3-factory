import { assert, expect, it } from "@effect/vitest";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { factoryHarness } from "./support/factory.ts";
import { controlledDiscord, messageEvent } from "./support/controlled-discord.ts";
import { unreachableBaseUrl } from "./support/controlled-model.ts";
import {
  DISCORD_PUBLIC_KEY,
  discordBot,
  discordConnectionSave,
  savedDiscordConnection,
} from "./support/chat-control.ts";

/** A Factory on a fresh home whose Chat control reaches the controlled Discord. */
async function discordFactory(c: Parameters<typeof controlledDiscord>[0]) {
  const discord = await controlledDiscord(c);
  discord.addBot(discordBot);
  const harness = await factoryHarness(c);
  const open = () => harness.open({ discordApiUrl: discord.apiUrl });
  return { discord, harness, open, factory: await open() };
}

it("an incomplete Discord connection can be saved while Chat control is Off", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();

  // Act
  const saved = await factory.updateDiscordConnection(
    discordConnectionSave({ publicKey: null, token: { kind: "keep" } }),
  );

  // Assert
  assert(saved.ok);
  expect(saved.value).toMatchObject({
    chatControlEnabled: false,
    connectionStatus: "incomplete",
    configuration: {
      applicationId: discordBot.applicationId,
      publicKey: null,
      tokenConfigured: false,
      revision: 1,
    },
  });
});

it("an Application ID beyond JavaScript's exact integer range is saved exactly as entered", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();

  // Act
  const saved = await factory.updateDiscordConnection(
    discordConnectionSave({ applicationId: " 18446744073709551615 " }),
  );

  // Assert
  assert(saved.ok);
  expect(saved.value.configuration.applicationId).toBe("18446744073709551615");
});

it("a malformed Application ID is rejected and the saved connection stays unchanged", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  const before = await factory.getDiscordSettings();

  // Act
  const saved = await factory.updateDiscordConnection(
    discordConnectionSave({ applicationId: "1.23456789012345e17" }),
  );

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues[0]).toMatchObject({
    code: "discord_application_id",
    path: "applicationId",
  });
  expect(await factory.getDiscordSettings()).toStrictEqual(before);
});

it("a Public Key that is not 64 hexadecimal characters is rejected", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();

  // Act
  const saved = await factory.updateDiscordConnection(
    discordConnectionSave({ publicKey: "not-a-public-key" }),
  );

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues[0]).toMatchObject({ code: "discord_public_key", path: "publicKey" });
});

it("the settings read reports a saved bot token without returning it", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  await savedDiscordConnection(factory);

  // Act
  const read = await factory.getDiscordSettings();

  // Assert
  assert(read.ok);
  expect(read.value).toMatchObject({
    connectionStatus: "off",
    configuration: {
      applicationId: discordBot.applicationId,
      publicKey: DISCORD_PUBLIC_KEY,
      tokenConfigured: true,
    },
  });
  expect(JSON.stringify(read)).not.toContain(discordBot.token);
});

it("a saved bot token lives only in an owner-only credential file outside SQLite", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  const directory = join(harness.processHome, "credentials", "chat-control");

  // Act
  await savedDiscordConnection(factory);

  // Assert
  await factory.close();
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(directory, files[0]!), "utf8")).toContain(discordBot.token);
  expect(await readFile(harness.databasePath)).not.toContain(Buffer.from(discordBot.token));
});

it("saving with the token left blank keeps the saved token for the next check", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  await savedDiscordConnection(factory);
  const resaved = await factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, publicKey: "b".repeat(64), token: { kind: "keep" } }),
  );
  assert(resaved.ok);

  // Act
  const checked = await factory.checkDiscordConnection({ revision: 2 });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck).toMatchObject({ revision: 2, outcome: "verified" });
  expect(discord.sessions.map((session) => session.token)).toStrictEqual([discordBot.token]);
});

it("removing the saved token while Off leaves the connection incomplete", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  await savedDiscordConnection(factory);

  // Act
  const removed = await factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "remove" } }),
  );

  // Assert
  assert(removed.ok);
  expect(removed.value.connectionStatus).toBe("incomplete");
  expect(removed.value.configuration.tokenConfigured).toBe(false);
});

it("replacing the saved Application ID with another is refused until the owner confirms the consequences", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedDiscordConnection(factory);

  // Act
  const changed = await factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      applicationId: "876543210987654321",
      token: { kind: "keep" },
    }),
  );

  // Assert
  assert(!changed.ok);
  expect(changed.error.issues[0]).toMatchObject({
    code: "discord_application_change",
    path: "applicationChangeConfirmed",
  });
  expect(await factory.getDiscordSettings()).toStrictEqual({ ok: true, value: saved });
});

it("a confirmed Application ID change is saved as the next revision", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  await savedDiscordConnection(factory);

  // Act
  const changed = await factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      applicationId: "876543210987654321",
      token: { kind: "keep" },
      applicationChangeConfirmed: true,
    }),
  );

  // Assert
  assert(changed.ok);
  expect(changed.value.configuration).toMatchObject({
    applicationId: "876543210987654321",
    tokenConfigured: true,
    revision: 2,
  });
});

it("a save refused as stale after staging its token leaves the committed token in use across restart", async (c) => {
  // Arrange
  const { discord, factory, open } = await discordFactory(c);
  await savedDiscordConnection(factory);
  const stale = await factory.updateDiscordConnection(
    discordConnectionSave({ revision: 0, token: { kind: "replace", value: "uncommitted-token" } }),
  );
  assert(!stale.ok);
  expect(stale.error.code).toBe("conflict");
  await factory.close();
  const reopened = await open();

  // Act
  const checked = await reopened.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck?.outcome).toBe("verified");
  expect(discord.sessions.map((session) => session.token)).toStrictEqual([discordBot.token]);
});

it("a replacement token that cannot be stored keeps the previous connection and token", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  const saved = await savedDiscordConnection(factory);
  const directory = join(harness.processHome, "credentials", "chat-control");
  await chmod(directory, 0o500);
  c.onTestFinished(() => chmod(directory, 0o700));

  // Act
  const replaced = await factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      publicKey: "b".repeat(64),
      token: { kind: "replace", value: "unstored-token" },
    }),
  );

  // Assert
  assert(!replaced.ok);
  expect(replaced.error.code).toBe("internal");
  expect(await factory.getDiscordSettings()).toStrictEqual({ ok: true, value: saved });
});

it("a replacement token of another application fails the check as an identity mismatch without trying the earlier token", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  discord.addBot({ token: "other-application-token", applicationId: "876543210987654321" });
  await savedDiscordConnection(factory);
  const replaced = await factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      token: { kind: "replace", value: "other-application-token" },
    }),
  );
  assert(replaced.ok);

  // Act
  const checked = await factory.checkDiscordConnection({ revision: 2 });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck).toMatchObject({
    revision: 2,
    outcome: "identity-mismatch",
    message: expect.stringContaining("876543210987654321"),
  });
  await discord.disconnected();
  expect(discord.sessions.map((session) => session.token)).toStrictEqual([
    "other-application-token",
  ]);
});

it("a token Discord does not accept fails the check without echoing the token", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  const saved = await savedDiscordConnection(factory, {
    token: { kind: "replace", value: "revoked-token-secret" },
  });

  // Act
  const checked = await factory.checkDiscordConnection({ revision: saved.configuration.revision });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck?.outcome).toBe("token-rejected");
  expect(JSON.stringify(checked)).not.toContain("revoked-token-secret");
  expect(discord.sessions).toHaveLength(0);
});

it("an application without the Message Content intent fails the check with setup guidance", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  discord.addBot({ ...discordBot, messageContentIntent: false });
  const saved = await savedDiscordConnection(factory);

  // Act
  const checked = await factory.checkDiscordConnection({ revision: saved.configuration.revision });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck).toMatchObject({
    outcome: "intent-disallowed",
    message: expect.stringContaining("Message Content Intent"),
  });
  await discord.disconnected();
});

it("a Discord Factory cannot reach is reported as unreachable", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  const factory = await harness.open({
    discordApiUrl: (await unreachableBaseUrl()).replace(/\/v1$/, "/api"),
  });
  const saved = await savedDiscordConnection(factory);

  // Act
  const checked = await factory.checkDiscordConnection({ revision: saved.configuration.revision });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck).toMatchObject({
    outcome: "unreachable",
    message: "Factory could not reach Discord.",
  });
});

it.effect(
  "a check whose Gateway session is not ready within 30 seconds times out and disconnects",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const discord = yield* Effect.promise(() => controlledDiscord(c));
      discord.addBot(discordBot);
      discord.holdReady();
      const harness = yield* Effect.promise(() => factoryHarness(c));
      const factory = yield* harness.service({ discordApiUrl: discord.apiUrl });
      yield* factory.updateDiscordConnection(discordConnectionSave());
      const check = yield* Effect.forkChild(factory.checkDiscordConnection({ revision: 1 }));
      yield* Effect.promise(() => discord.identified());

      // Act
      yield* TestClock.adjust(30_000);

      // Assert
      const checked = yield* Fiber.join(check);
      assert(checked.ok);
      expect(checked.value.latestCheck).toMatchObject({
        outcome: "timed-out",
        message: "The Gateway session did not become ready within 30 seconds.",
      });
      yield* Effect.promise(() => discord.disconnected());
    }),
);

it("a second check while one runs is refused without opening another Gateway session", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  discord.holdReady();
  await savedDiscordConnection(factory);
  const first = factory.checkDiscordConnection({ revision: 1 });
  await discord.identified();

  // Act
  const second = await factory.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(!second.ok);
  expect(second.error.code).toBe("conflict");
  expect(discord.sessions).toHaveLength(1);
  discord.releaseReady();
  expect((await first).ok).toBe(true);
});

it("the settings read reports a check while it runs", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  discord.holdReady();
  await savedDiscordConnection(factory);
  const check = factory.checkDiscordConnection({ revision: 1 });
  await discord.identified();

  // Act
  const read = await factory.getDiscordSettings();

  // Assert
  assert(read.ok);
  expect(read.value.connectionStatus).toBe("checking");
  discord.releaseReady();
  await check;
});

it("closing Factory during a check ends its Gateway session", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  discord.holdReady();
  await savedDiscordConnection(factory);
  const check = factory.checkDiscordConnection({ revision: 1 }).catch(() => "interrupted");
  await discord.identified();

  // Act
  await factory.close();

  // Assert
  await discord.disconnected();
  expect(await check).toBe("interrupted");
});

it("an Off check handles no Discord traffic and sends Discord nothing beyond its login", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  const guild = {
    id: "400000000000000001",
    name: "Team",
    channels: [{ id: "400000000000000002", name: "factory" }],
  };
  discord.addGuild(guild);
  discord.trafficOnReady.push(
    messageEvent({
      bot: discordBot,
      guildId: guild.id,
      channelId: guild.channels[0]!.id,
      id: "300000000000000001",
    }),
  );
  await savedDiscordConnection(factory);

  // Act
  const checked = await factory.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(checked.ok);
  expect(checked.value.latestCheck?.outcome).toBe("verified");
  await discord.disconnected();
  expect(discord.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual([
    "GET /api/v10/gateway/bot",
  ]);
});

it("check refuses a revision other than the saved one without contacting Discord", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  await savedDiscordConnection(factory);
  const changed = await factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, publicKey: "b".repeat(64), token: { kind: "keep" } }),
  );
  assert(changed.ok);

  // Act
  const checked = await factory.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(!checked.ok);
  expect(checked.error.code).toBe("conflict");
  expect(discord.requests).toHaveLength(0);
});

it("check refuses an incomplete connection without contacting Discord", async (c) => {
  // Arrange
  const { discord, factory } = await discordFactory(c);
  await savedDiscordConnection(factory, { publicKey: null });

  // Act
  const checked = await factory.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(!checked.ok);
  expect(checked.error.code).toBe("validation");
  expect(discord.requests).toHaveLength(0);
});

it("saving a new configuration keeps the earlier check as dated evidence for its own revision", async (c) => {
  // Arrange
  const { factory } = await discordFactory(c);
  await savedDiscordConnection(factory);
  assert((await factory.checkDiscordConnection({ revision: 1 })).ok);

  // Act
  const changed = await factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, publicKey: "b".repeat(64), token: { kind: "keep" } }),
  );

  // Assert
  assert(changed.ok);
  expect(changed.value.configuration.revision).toBe(2);
  expect(changed.value.latestCheck).toMatchObject({ revision: 1, outcome: "verified" });
});

it("reopening Factory with a saved connection opens no Gateway session", async (c) => {
  // Arrange
  const { discord, factory, open } = await discordFactory(c);
  await savedDiscordConnection(factory);
  await factory.close();

  // Act
  const reopened = await open();

  // Assert
  expect((await reopened.getDiscordSettings()).ok).toBe(true);
  expect(discord.requests).toHaveLength(0);
  expect(discord.sessions).toHaveLength(0);
});

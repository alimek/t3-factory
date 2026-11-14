import { assert, expect, it } from "@effect/vitest";
import { PARTICIPANT_ID } from "./support/controlled-discord.ts";
import {
  ALLOWED_CHANNEL,
  chatControlWorld,
  chatModelSave,
  discordBot,
  discordConnectionSave,
  discordSettingsWhen,
  openSessions,
  OTHER_CHANNEL,
  servingAgain,
  statusIs,
  turnedOn,
} from "./support/chat-control.ts";
import { factoryHarness } from "./support/factory.ts";

const COMMANDS = /^\/api\/v10\/applications\/\d+\/commands$/;

it("Access keeps Discord IDs beyond JavaScript's exact integer range exactly as entered", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();

  // Act
  const saved = await factory.updateDiscordAccess({
    revision: 0,
    users: [" 18446744073709551615 "],
    channels: [{ channelId: "18446744073709551614", projectIds: [] }],
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.access).toMatchObject({
    users: ["18446744073709551615"],
    channels: [{ channelId: "18446744073709551614", projectIds: [] }],
    revision: 1,
  });
});

it("a user listed twice in Access is refused and the saved Access stays unchanged", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  const before = await factory.getDiscordSettings();

  // Act
  const saved = await factory.updateDiscordAccess({
    revision: 0,
    users: [PARTICIPANT_ID, ` ${PARTICIPANT_ID}`],
    channels: [],
  });

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues[0]).toMatchObject({
    code: "discord_access_duplicate",
    path: "users[1]",
  });
  expect(await factory.getDiscordSettings()).toStrictEqual(before);
});

it("a channel cannot be granted a Project Factory does not know", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();

  // Act
  const saved = await factory.updateDiscordAccess({
    revision: 0,
    users: [],
    channels: [{ channelId: ALLOWED_CHANNEL, projectIds: ["no-such-project"] }],
  });

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues[0]).toMatchObject({
    code: "discord_access_project",
    path: "channels[0].projectIds[0]",
  });
});

it("an Access save from an older revision is refused as a conflict", async (c) => {
  // Arrange
  const { factory } = await chatControlWorld(c);

  // Act
  const saved = await factory.updateDiscordAccess({ revision: 0, users: [], channels: [] });

  // Assert
  assert(!saved.ok);
  expect(saved.error.code).toBe("conflict");
});

it("Chat control does not turn On without a complete Language model", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  assert((await factory.updateDiscordConnection(discordConnectionSave())).ok);
  assert((await factory.updateChatModelSettings(chatModelSave({ model: null }))).ok);

  // Act
  const on = await factory.setChatControlEnabled({ enabled: true });

  // Assert
  assert(!on.ok);
  expect(on.error.issues).toStrictEqual([
    {
      code: "chat_control_incomplete",
      path: "model.model",
      message: "Save the Language model name.",
    },
  ]);
  const read = await factory.getDiscordSettings();
  assert(read.ok);
  expect(read.value.chatControlEnabled).toBe(false);
});

it("Chat control turns On with a keyless model, no passed tests and empty Access", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  assert((await factory.updateDiscordAccess({ revision: 1, users: [], channels: [] })).ok);

  // Act
  const on = await factory.setChatControlEnabled({ enabled: true });

  // Assert
  assert(on.ok);
  expect(on.value.chatControlEnabled).toBe(true);
  await discord.request("PUT", COMMANDS);
  expect(await discordSettingsWhen(factory, statusIs("connected"))).toMatchObject({
    connectionProblem: null,
    commandSetup: { outcome: "registered" },
    needsAttention: false,
  });
});

it("the operating connection registers only /factory reset, after Discord verified the application", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);

  // Act
  await turnedOn(factory, discord);

  // Assert
  expect(discord.commands.get(discordBot.applicationId)).toStrictEqual([
    {
      name: "factory",
      description: "Factory Chat control",
      type: 1,
      contexts: [0],
      integration_types: [0],
      options: [
        {
          type: 1,
          name: "reset",
          description: "Clear this thread's shared Chat control conversation",
        },
      ],
    },
  ]);
});

it("a token of another application is rejected while On and registers no command", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  discord.addBot({ token: "other-application-token", applicationId: "987654321098765432" });
  const replaced = await factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      token: { kind: "replace", value: "other-application-token" },
    }),
  );
  assert(replaced.ok);

  // Act
  await factory.setChatControlEnabled({ enabled: true });

  // Assert
  expect(await discordSettingsWhen(factory, statusIs("rejected"))).toMatchObject({
    connectionProblem: { outcome: "identity-mismatch" },
    needsAttention: true,
  });
  expect(discord.requested("PUT", COMMANDS)).toHaveLength(0);
});

it("On persists through a restart and the reopened Factory reconnects by itself", async (c) => {
  // Arrange
  const { discord, factory, open } = await chatControlWorld(c);
  await turnedOn(factory, discord);
  await factory.close();

  // Act
  const reopened = await open();

  // Assert
  await servingAgain(discord, 2);
  expect(await discordSettingsWhen(reopened, statusIs("connected"))).toMatchObject({
    chatControlEnabled: true,
  });
});

it("Off disconnects and keeps the configuration and Access", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  await turnedOn(factory, discord);
  const before = await factory.getDiscordSettings();
  assert(before.ok);

  // Act
  const off = await factory.setChatControlEnabled({ enabled: false });

  // Assert
  assert(off.ok);
  await discord.disconnected();
  expect(off.value).toMatchObject({
    chatControlEnabled: false,
    connectionStatus: "off",
    configuration: before.value.configuration,
    access: before.value.access,
  });
});

it("a token Discord rejects while On stays rejected across a restart until the owner retries", async (c) => {
  // Arrange
  const { discord, factory, open } = await chatControlWorld(c);
  discord.removeBot(discordBot.token);
  await factory.setChatControlEnabled({ enabled: true });
  await discordSettingsWhen(factory, statusIs("rejected"));
  await factory.close();
  const reopened = await open();

  // Act
  const read = await reopened.getDiscordSettings();

  // Assert
  assert(read.ok);
  expect(read.value).toMatchObject({
    chatControlEnabled: true,
    connectionStatus: "rejected",
    connectionProblem: { outcome: "token-rejected" },
  });
  expect(discord.requested("GET", /^\/api\/v10\/gateway\/bot$/)).toHaveLength(1);
});

it("retrying a rejected connection while On reconnects through the same supervisor", async (c) => {
  // Arrange
  const world = await chatControlWorld(c);
  world.discord.removeBot(discordBot.token);
  await world.factory.setChatControlEnabled({ enabled: true });
  await discordSettingsWhen(world.factory, statusIs("rejected"));
  world.discord.addBot(discordBot);

  // Act
  const retried = await world.factory.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(retried.ok);
  await world.discord.request("PUT", COMMANDS);
  expect(openSessions(world.discord)).toHaveLength(1);
  expect(await discordSettingsWhen(world.factory, statusIs("connected"))).toMatchObject({
    latestCheck: null,
  });
});

it("checking while On inspects the running connection without opening another session", async (c) => {
  // Arrange
  const world = await chatControlWorld(c);
  await turnedOn(world.factory, world.discord);
  await discordSettingsWhen(world.factory, statusIs("connected"));

  // Act
  const checked = await world.factory.checkDiscordConnection({ revision: 1 });

  // Assert
  assert(checked.ok);
  expect(checked.value).toMatchObject({ connectionStatus: "connected", latestCheck: null });
  expect(world.discord.sessions).toHaveLength(1);
});

it("a Discord outage while On keeps retrying and connects once Discord is reachable", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  discord.setGatewayAvailable(false);
  await factory.setChatControlEnabled({ enabled: true });
  await discordSettingsWhen(factory, statusIs("reconnecting"));

  // Act
  discord.setGatewayAvailable(true);

  // Assert
  await discord.request("PUT", COMMANDS);
  expect(await discordSettingsWhen(factory, statusIs("connected"))).toMatchObject({
    connectionProblem: null,
    needsAttention: false,
  });
});

it("a transient Discord failure while On shows a reconnecting connection with the Settings indicator", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  discord.setGatewayAvailable(false);

  // Act
  await factory.setChatControlEnabled({ enabled: true });

  // Assert
  expect(await discordSettingsWhen(factory, statusIs("reconnecting"))).toMatchObject({
    connectionProblem: { outcome: "failed", message: expect.stringContaining("HTTP 503") },
    needsAttention: true,
  });
});

it("replacing the bot token of the same application while On reconnects with the new token", async (c) => {
  // Arrange
  const world = await chatControlWorld(c);
  await turnedOn(world.factory, world.discord);
  world.discord.addBot({ token: "rotated-bot-token", applicationId: discordBot.applicationId });

  // Act
  const rotated = await world.factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "replace", value: "rotated-bot-token" } }),
  );

  // Assert
  assert(rotated.ok);
  await world.discord.request("PUT", COMMANDS, 2);
  expect(openSessions(world.discord).map((session) => session.token)).toStrictEqual([
    "rotated-bot-token",
  ]);
});

it("removing a required Language model value while On is refused", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  await turnedOn(factory, discord);

  // Act
  const saved = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: null }),
  );

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues).toMatchObject([{ path: "baseUrl" }]);
});

it("removing the bot token while On is refused", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  await turnedOn(factory, discord);

  // Act
  const saved = await factory.updateDiscordConnection(
    discordConnectionSave({ revision: 1, token: { kind: "remove" } }),
  );

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues).toMatchObject([{ code: "discord_required", path: "token" }]);
});

it("changing the Application ID while On is refused even with the consequence confirmed", async (c) => {
  // Arrange
  const { discord, factory } = await chatControlWorld(c);
  await turnedOn(factory, discord);

  // Act
  const saved = await factory.updateDiscordConnection(
    discordConnectionSave({
      revision: 1,
      applicationId: "987654321098765432",
      token: { kind: "keep" },
      applicationChangeConfirmed: true,
    }),
  );

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues).toMatchObject([
    { code: "discord_application_change", path: "applicationId" },
  ]);
});

it("Access for a second channel saves while the connection keeps its own revision", async (c) => {
  // Arrange
  const { factory, project } = await chatControlWorld(c);

  // Act
  const saved = await factory.updateDiscordAccess({
    revision: 1,
    users: [PARTICIPANT_ID],
    channels: [
      { channelId: ALLOWED_CHANNEL, projectIds: [project.id] },
      { channelId: OTHER_CHANNEL, projectIds: [project.id] },
    ],
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.access.revision).toBe(2);
  expect(saved.value.configuration.revision).toBe(1);
});

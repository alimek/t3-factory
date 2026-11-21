import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "./support/test.ts";
import { expect, type App, type Screen } from "e2e";
import type {
  ChatModelSettings,
  DiscordSettings,
  Result,
} from "../packages/contracts/src/index.ts";
import type { MessageFault } from "../apps/backend/test/support/controlled-discord.ts";
import { fixtureHandles } from "./support/fixture/handle.ts";
import { openApproved, openRemoteBrowser } from "./support/remote-access.ts";

/** Participants, moderators and Discord itself, as the fixture's controlled Discord plays them. */
const discord = (baseUrl: string | undefined) => fixtureHandles({ baseUrl }).discord;

/**
 * A chat-completions provider on loopback that records the headers of each request and answers
 * "OK", or `failure` with an empty body once a journey sets it, or once the tool call a journey
 * set.
 */
async function controlledProvider() {
  const requests: IncomingHttpHeaders[] = [];
  const state: {
    failure: number | null;
    toolCall: { name: string; input: unknown } | null;
  } = { failure: null, toolCall: null };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(request.headers);
      if (state.failure !== null) {
        response.writeHead(state.failure, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const toolCall = state.toolCall;
      state.toolCall = null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-ui",
          object: "chat.completion",
          created: 0,
          model: "ui-model",
          choices: [
            toolCall
              ? {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-ui",
                        type: "function",
                        function: {
                          name: toolCall.name,
                          arguments: JSON.stringify(toolCall.input),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                }
              : { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway/v1`,
    requests,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let provider: Awaited<ReturnType<typeof controlledProvider>>;
/** A second provider a journey moves the Language model to, closed in teardown. */
let movedProvider: Awaited<ReturnType<typeof controlledProvider>> | null = null;
/** Runs a journey started through chat and leaves for teardown to archive. */
const startedRuns: string[] = [];

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1000 });
  provider = await controlledProvider();
});

afterEach(async ({ app }) => {
  await movedProvider?.close();
  movedProvider = null;
  // Journeys share one fixture; a later journey must start with Chat control Off and without
  // this journey's Runs.
  for (const runId of startedRuns.splice(0)) {
    const archived = await hostCall(app.baseUrl, "POST", `/api/runs/${runId}/archive`, undefined);
    assert(archived.ok, JSON.stringify(archived));
  }
  const off = await hostCall(app.baseUrl, "PUT", "/api/chat-control/enabled", { enabled: false });
  assert(off.ok, JSON.stringify(off));
  await provider.close();
});

async function chatModelSettings(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/chat-control/model", baseUrl));
  return (await response.json()) as Result<ChatModelSettings>;
}

/** Fills the Language model's provider, base URL and model for the controlled provider. */
async function fillChatModel(screen: Screen) {
  const connection = screen.getByRole("region", "Connection");
  await connection.getByRole("combobox", /^Provider: /).tap();
  await screen.getByRole("option", /^OpenAI-compatible/).tap();
  await connection.getByLabel("Base URL").fill(provider.baseUrl);
  await connection.getByLabel("Model").fill("ui-model");
  return connection;
}

test("the host saves a keyed Language model, tests the saved connection and never sees the key again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/settings/chat-control/model");
  const connection = await fillChatModel(screen);
  await connection.getByLabel("API key").fill("sk-ui-journey");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(connection.getByText("Stored", { exact: true })).toBeVisible();
  await app.screenshot("chat-model-saved");

  // Act
  await screen.getByRole("button", "Test connection").tap();

  // Assert
  await expect(screen.getByText("Test passed", { exact: true })).toBeVisible();
  await expect(connection.getByText("Last tested")).toBeVisible();
  assert.deepStrictEqual(
    provider.requests.map((headers) => headers.authorization),
    ["Bearer sk-ui-journey"],
  );
  await app.screenshot("chat-model-tested");
  await browser.reload();
  await expect(
    screen.getByRole("region", "Connection").getByRole("button", "Replace the API key"),
  ).toBeVisible();
  await expect(screen.getByRole("region", "Connection").getByLabel("Base URL")).toHaveValue(
    provider.baseUrl,
  );
  const settings = await chatModelSettings(app.baseUrl);
  expect(settings).toMatchObject({ ok: true, value: { configuration: { keyConfigured: true } } });
  assert(!JSON.stringify(settings).includes("sk-ui-journey"));
});

/**
 * The Language model saved with `key` for the controlled provider through the host API, open in
 * Settings with its Base URL moved to a second provider, so the stored key needs a choice.
 */
async function storedKeyMoved(app: App, screen: Screen, key: string) {
  const model = await chatModelSettings(app.baseUrl);
  assert(model.ok);
  const saved = await hostCall(app.baseUrl, "PUT", "/api/chat-control/model", {
    revision: model.value.configuration.revision,
    providerKind: "openai-compatible",
    baseUrl: provider.baseUrl,
    model: "ui-model",
    key: { kind: "replace", value: key },
  });
  assert(saved.ok, JSON.stringify(saved));
  movedProvider = await controlledProvider();
  await app.open("/settings/chat-control/model");
  const connection = screen.getByRole("region", "Connection");
  await connection.getByLabel("Base URL").fill(movedProvider.baseUrl);
  await expectKeyUndecided(screen);
  return { connection, moved: movedProvider };
}

/**
 * The stored key waits for the owner's choice: the Choose tag, the key field invalid and described
 * by its attention card, and no Save.
 */
async function expectKeyUndecided(screen: Screen) {
  const connection = screen.getByRole("region", "Connection");
  const keyField = connection.getByRole("group", "API key", { exact: true });
  await expect(keyField.getByText("Choose", { exact: true })).toBeVisible();
  await expect(keyField).toHaveAttribute("aria-invalid", "true");
  await expect(keyField).toHaveAttribute("aria-describedby", "chat-model-key-problem");
  await expect(screen.getByText("Send the stored key to the new address?")).toBeVisible();
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeDisabled();
}

test("a stored key the host chose to use at a new address is the one the new provider receives", async ({
  app,
  screen,
}) => {
  // Arrange
  const { connection, moved } = await storedKeyMoved(app, screen, "sk-ui-moved");
  await app.screenshot("chat-model-key-choose");
  await connection.getByRole("button", "Use stored key", { exact: true }).tap();
  await expect(connection.getByText("Stored · used at the new address")).toBeVisible();
  await expect(screen.getByText("Send the stored key to the new address?")).toHaveCount(0);
  await app.screenshot("chat-model-key-reused");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(connection.getByRole("button", "Replace the API key")).toBeVisible();

  // Act
  await screen.getByRole("button", "Test connection").tap();

  // Assert
  await expect(screen.getByText("Test passed", { exact: true })).toBeVisible();
  assert.deepStrictEqual(
    moved.requests.map((headers) => headers.authorization),
    ["Bearer sk-ui-moved"],
  );
  expect(await chatModelSettings(app.baseUrl)).toMatchObject({
    ok: true,
    value: { configuration: { baseUrl: moved.baseUrl, keyConfigured: true } },
  });
});

test("after the address changes, Replace opens a blank key field that can't be saved", async ({
  app,
  screen,
}) => {
  // Arrange
  const { connection } = await storedKeyMoved(app, screen, "sk-ui-blank");

  // Act
  await connection.getByRole("button", "Replace the API key").tap();

  // Assert
  await expect(connection.getByLabel("API key")).toBeFocused();
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeDisabled();
  await app.screenshot("chat-model-key-replace-open");
});

test("after the address changes, Cancel on a replacement returns to the stored-key choice", async ({
  app,
  screen,
}) => {
  // Arrange
  const { connection } = await storedKeyMoved(app, screen, "sk-ui-kept");
  await connection.getByRole("button", "Replace the API key").tap();
  await expect(connection.getByLabel("API key")).toBeFocused();

  // Act
  await connection.getByRole("button", "Cancel", { exact: true }).tap();

  // Assert
  await expectKeyUndecided(screen);
});

test("after the address changes, removing the stored key saves the new address without a key", async ({
  app,
  screen,
}) => {
  // Arrange
  const { connection, moved } = await storedKeyMoved(app, screen, "sk-ui-removed");
  await connection.getByRole("button", "Remove the API key").tap();
  await expect(connection.getByText("None", { exact: true })).toBeVisible();
  await expect(connection.getByRole("button", "Undo removing the API key")).toBeVisible();
  await app.screenshot("chat-model-key-removed");

  // Act
  await screen.getByRole("button", "Save", { exact: true }).tap();

  // Assert
  await expect(connection.getByLabel("API key")).toBeVisible();
  expect(await chatModelSettings(app.baseUrl)).toMatchObject({
    ok: true,
    value: { configuration: { baseUrl: moved.baseUrl, keyConfigured: false } },
  });
});

test("leaving the Language model page with unsaved edits asks before discarding them", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/settings/chat-control/model");
  const connection = screen.getByRole("region", "Connection");
  await connection.getByLabel("Model").fill("unsaved-model");
  await expect(screen.getByRole("button", "Discard", { exact: true })).toBeVisible();

  // Act
  await screen
    .getByRole("navigation", "Settings sections")
    .getByRole("link", "Run titles", { exact: true })
    .tap();

  // Assert
  await expect(screen.getByRole("dialog", "Discard unsaved Language model changes?")).toBeVisible();
  // Hovering waits for the dialog's opening zoom to settle before the evidence frame.
  await screen.getByRole("button", "Keep editing").hover();
  await app.screenshot("chat-model-discard-guard");
  await screen.getByRole("button", "Keep editing").tap();
  await expect(connection.getByLabel("Model")).toHaveValue("unsaved-model");
});

/** The bot the fixture's controlled Discord knows and the Gateway sessions it saw. */
const controlledDiscord = (baseUrl: string | undefined) => discord(baseUrl).state();

async function discordSettings(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/chat-control/discord", baseUrl));
  return (await response.json()) as Result<DiscordSettings>;
}

test("the host saves the bot, checks it over the Gateway and never sees the token again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { bot } = await controlledDiscord(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  await expect(screen.getByRole("switch", "Chat control")).toBeDisabled();
  const setupGuide = screen.getByRole("link", /^Setup guide/);
  await expect(setupGuide).toBeVisible();
  // The Setup guide is Discord's page, so it opens in a new tab.
  await expect(setupGuide).toHaveAttribute("target", "_blank");
  await app.screenshot("chat-discord-not-set-up");
  const botCard = screen.getByRole("region", "Bot");
  await botCard.getByLabel("Public key").fill("ab".repeat(32));
  await botCard.getByLabel("Bot token").fill(bot.token);
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(botCard.getByText("Stored", { exact: true })).toBeVisible();
  await app.screenshot("chat-discord-saved");

  // Act
  await screen.getByRole("button", "Check connection").tap();

  // Assert
  await expect(botCard.getByText("Gateway verified")).toBeVisible();
  await expect(botCard.getByText("Factory bot", { exact: true })).toBeVisible();
  await expect(screen.getByRole("link", /^Setup guide/)).toHaveCount(0);
  const discord = await controlledDiscord(app.baseUrl);
  assert.deepStrictEqual(discord.sessions, [{ token: bot.token, ready: true, closed: true }]);
  await app.screenshot("chat-discord-checked");
  await browser.reload();
  await expect(
    screen.getByRole("region", "Bot").getByRole("button", "Replace the bot token"),
  ).toBeVisible();
  const settings = await discordSettings(app.baseUrl);
  expect(settings).toMatchObject({
    ok: true,
    value: {
      configuration: { tokenConfigured: true },
      latestCheck: {
        outcome: "verified",
        applicationId: bot.applicationId,
        botName: "Factory bot",
      },
    },
  });
  assert(!JSON.stringify(settings).includes(bot.token));
});

test("leaving the Discord page with unsaved bot edits asks before discarding them", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/settings/chat-control/discord");
  const botCard = screen.getByRole("region", "Bot");
  await botCard.getByLabel("Public key").fill("cd".repeat(32));
  await expect(screen.getByRole("button", "Discard", { exact: true })).toBeVisible();

  // Act
  await screen
    .getByRole("navigation", "Settings sections")
    .getByRole("link", "Language model", { exact: true })
    .tap();

  // Assert
  await expect(screen.getByRole("dialog", "Discard unsaved Bot changes?")).toBeVisible();
  // Hovering waits for the dialog's opening zoom to settle before the evidence frame.
  await screen.getByRole("button", "Keep editing").hover();
  await app.screenshot("chat-discord-discard-guard");
  await screen.getByRole("button", "Keep editing").tap();
  await expect(botCard.getByLabel("Public key")).toHaveValue("cd".repeat(32));
});

test("the Discord page's language model link opens Language model, and Esc or ✕ returns with the bot edits kept", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const model = await chatModelSettings(app.baseUrl);
  assert(model.ok);
  // Without a saved model the switch's reason links it.
  const cleared = await hostCall(app.baseUrl, "PUT", "/api/chat-control/model", {
    revision: model.value.configuration.revision,
    providerKind: null,
    baseUrl: null,
    model: null,
    key: { kind: "remove" },
  });
  assert(cleared.ok, JSON.stringify(cleared));
  await app.open("/settings/chat-control/discord");
  const publicKey = screen.getByRole("region", "Bot").getByLabel("Public key");
  await publicKey.fill("cd".repeat(32));
  await app.screenshot("chat-discord-return-1-edited");
  const languageModel = screen.getByRole("link", "a language model");

  // Act
  await languageModel.tap();
  await expect(screen.getByRole("region", "Connection")).toBeVisible();
  await app.screenshot("chat-discord-return-2-language-model");
  await browser.keyboard.press("Escape");

  // Assert
  await expect(publicKey).toHaveValue("cd".repeat(32));
  await app.screenshot("chat-discord-return-3-back-after-esc");
  await languageModel.tap();
  await expect(screen.getByRole("region", "Connection")).toBeVisible();
  await screen.getByRole("button", "Close", { exact: true }).tap();
  await expect(publicKey).toHaveValue("cd".repeat(32));
  await expect(screen.getByRole("dialog", /^Discard unsaved/)).toHaveCount(0);
  await app.screenshot("chat-discord-return-4-back-after-close");
  // Saving the model there clears the switch's model reason on return.
  await languageModel.tap();
  await fillChatModel(screen);
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByRole("button", "Discard", { exact: true })).toHaveCount(0);
  await browser.keyboard.press("Escape");
  await expect(publicKey).toHaveValue("cd".repeat(32));
  await expect(languageModel).toHaveCount(0);
  await screen.getByRole("button", "Discard", { exact: true }).tap();
});

/** The fixture's first Project, as the Access section lists it. */
async function firstProject(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/projects", baseUrl));
  const catalog = (await response.json()) as Result<{ projects: { id: string; title: string }[] }>;
  assert(catalog.ok);
  return catalog.value.projects[0]!;
}

async function hostCall(baseUrl: string | undefined, method: string, path: string, body: unknown) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { "content-type": "application/json", "x-factory-request": "1" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Result<DiscordSettings & ChatModelSettings>;
}

/** A complete saved Discord connection and keyless Language model, saved through the host API. */
async function completeChatControl(baseUrl: string | undefined) {
  const { bot } = await controlledDiscord(baseUrl);
  const discord = await discordSettings(baseUrl);
  const model = await chatModelSettings(baseUrl);
  assert(discord.ok && model.ok);
  const connection = await hostCall(baseUrl, "PUT", "/api/chat-control/discord/connection", {
    revision: discord.value.configuration.revision,
    publicKey: "ab".repeat(32),
    token: { kind: "replace", value: bot.token },
  });
  assert(connection.ok, JSON.stringify(connection));
  const saved = await hostCall(baseUrl, "PUT", "/api/chat-control/model", {
    revision: model.value.configuration.revision,
    providerKind: "openai-compatible",
    baseUrl: provider.baseUrl,
    model: "ui-model",
    key: { kind: "remove" },
  });
  assert(saved.ok, JSON.stringify(saved));
}

test("one Save writes the bot and then Access, and names the channel that got its first Project", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const project = await firstProject(app.baseUrl);
  const before = await discordSettings(app.baseUrl);
  assert(before.ok);
  await app.open("/settings/chat-control/discord");
  await screen.getByRole("region", "Bot").getByLabel("Public key").fill("ef".repeat(32));
  const access = screen.getByRole("region", "Access");
  await access.getByLabel("Users").fill("200000000000000001");
  await access.getByRole("button", "Add channel").tap();
  await access.getByLabel("Channel 1 ID").fill("400000000000000002");
  await access.getByRole("button", /^Channel 1 Projects: /).tap();
  await screen.getByRole("menuitemcheckbox", project.title).tap();
  await browser.keyboard.press("Escape");

  // Act
  await screen.getByRole("button", "Save", { exact: true }).tap();

  // Assert
  await expect(screen.getByText(/^Everyone who can read .* sees the bot’s replies$/)).toBeVisible();
  await expect(screen.getByRole("button", "Discard", { exact: true })).toHaveCount(0);
  const settings = await discordSettings(app.baseUrl);
  expect(settings).toMatchObject({
    ok: true,
    value: {
      configuration: {
        publicKey: "ef".repeat(32),
        revision: before.value.configuration.revision + 1,
      },
      access: {
        revision: before.value.access.revision + 1,
        users: ["200000000000000001"],
        channels: [{ channelId: "400000000000000002", projectIds: [project.id] }],
      },
    },
  });
  await app.screenshot("chat-discord-access-saved");
});

test("the host turns Chat control On with the switch and sees the connection badge", async ({
  app,
  screen,
}) => {
  // Arrange
  await completeChatControl(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  const toggle = screen.getByRole("switch", "Chat control");
  await expect(toggle).toBeEnabled();

  // Act
  await toggle.tap();

  // Assert
  await expect(toggle).toBeChecked();
  await expect(screen.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  await settingsWhen<DiscordSettings>(
    app.baseUrl,
    "/api/chat-control/discord",
    (settings) => settings.commandSetup?.outcome === "registered",
  );
  const { sessions } = await controlledDiscord(app.baseUrl);
  assert.strictEqual(sessions.filter((session) => !session.closed).length, 1);
  await app.screenshot("chat-discord-on");
});

const TEST_USERS = ["200000000000000001", "200000000000000002"];
const TEST_CHANNEL = "400000000000000002";
const REFUSING_CHANNEL = "400000000000000003";
/** A channel ID Discord does not know, as after the channel was deleted. */
const GONE_CHANNEL = "400000000000000099";

/**
 * Operating Chat control whose Access allows two users in two channels, where the second channel's
 * permissions refuse the bot's posts, then in `extraChannels`.
 */
async function accessTestReady(baseUrl: string | undefined, extraChannels: string[] = []) {
  await discord(baseUrl).posting({ channelId: REFUSING_CHANNEL, denied: true });
  await operatingChatControl(baseUrl, {
    users: TEST_USERS,
    channels: [TEST_CHANNEL, REFUSING_CHANNEL, ...extraChannels],
  });
}

test("sending the access test asks each allowed user to reply and names the channels the bot can't post in or that are gone", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 900 });
  await accessTestReady(app.baseUrl, [GONE_CHANNEL]);
  await app.open("/settings/chat-control/discord");
  const accessCard = screen.getByRole("region", "Access");
  await expect(accessCard.getByRole("button", "Send access test")).toBeEnabled();
  await app.screenshot("chat-discord-access-test-1-not-sent");

  // Act
  await accessCard.getByRole("button", "Send access test").tap();

  // Assert
  await expect(accessCard.getByText("Waiting", { exact: true })).toHaveCount(2);
  await expect(accessCard.getByText("Can’t post", { exact: true })).toBeVisible();
  await expect(accessCard.getByRole("button", "Send again")).toBeEnabled();
  await app.screenshot("chat-discord-access-test-2-sent");
  const card = screen.getByText(/^Factory bot can’t post in /);
  await expect(card).toBeVisible();
  // A gone channel gets the card to remove it, also once Discord's name lookup marked it unknown.
  await expect(screen.getByText(`${GONE_CHANNEL} no longer exists`, { exact: true })).toBeVisible();
  await expect(screen.getByText("Remove it, then send again.", { exact: true })).toBeVisible();
  await expect(screen.getByText("Fix the IDs, then save.", { exact: true })).toHaveCount(0);
  // The cards sit below the fold; bring the last one fully into view for the screenshot.
  await browser.evaluate(() => {
    const alerts = Array.from(document.querySelectorAll('[role="status"]'));
    alerts
      .find((alert) => alert.textContent.includes("no longer exist"))
      ?.scrollIntoView({ block: "end" });
    return null;
  });
  await app.screenshot("chat-discord-access-test-3-cant-post-and-gone");
});

test("a user who replied to the access test shows Reached, which stays while Chat control is Off", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 900 });
  await accessTestReady(app.baseUrl);
  const sent = await hostCall(app.baseUrl, "POST", "/api/chat-control/discord/access-test", {});
  assert(sent.ok, JSON.stringify(sent));
  await discord(app.baseUrl).replyToAccessTest({ userId: TEST_USERS[0]!, channelId: TEST_CHANNEL });
  await settingsWhen<DiscordSettings>(
    app.baseUrl,
    "/api/chat-control/discord",
    (settings) => typeof settings.access.test?.users[TEST_USERS[0]!] === "string",
  );
  await app.open("/settings/chat-control/discord");
  const accessCard = screen.getByRole("region", "Access");
  await expect(accessCard.getByText(/^Reached · /)).toBeVisible();
  await expect(accessCard.getByText("Waiting", { exact: true })).toHaveCount(1);
  await app.screenshot("chat-discord-access-test-4-reached");
  const toggle = screen.getByRole("switch", "Chat control");

  // Act
  await toggle.tap();

  // Assert
  await expect(toggle).not.toBeChecked();
  await expect(accessCard.getByRole("button", "Send again")).toBeDisabled();
  await expect(accessCard.getByText("Turn on Chat control to send", { exact: true })).toBeVisible();
  await expect(accessCard.getByText(/^Reached · /)).toBeVisible();
  await app.screenshot("chat-discord-access-test-5-off");
});

test("the host retries failed command setup while the Gateway is connected", async ({
  app,
  screen,
}) => {
  // Arrange
  await completeChatControl(app.baseUrl);
  await discord(app.baseUrl).commands({ available: false });
  const on = await hostCall(app.baseUrl, "PUT", "/api/chat-control/enabled", { enabled: true });
  assert(on.ok);
  await settingsWhen<DiscordSettings>(
    app.baseUrl,
    "/api/chat-control/discord",
    (settings) =>
      settings.connectionStatus === "connected" && settings.commandSetup?.outcome === "failed",
  );
  await app.open("/settings/chat-control/discord");
  const failure = screen.getByText("/factory reset isn’t registered");
  await expect(failure).toBeVisible();
  await app.screenshot("chat-discord-command-failed");
  await discord(app.baseUrl).commands({ available: true });

  // Act
  await screen.getByRole("button", "Retry connection").tap();

  // Assert
  await expect(failure).toHaveCount(0);
  await expect(screen.getByRole("button", "Retry connection")).toHaveCount(0);
  await app.screenshot("chat-discord-command-retried");
});

test("an approved client's Settings has no Chat control section or search entry", async ({
  app,
  screen,
}) => {
  // Arrange
  await openRemoteBrowser(app);
  await openApproved(app, "/settings/run-titles");
  const sections = screen.getByRole("navigation", "Settings sections");
  await expect(
    sections.getByRole("link", "Run titles, Managed on the Factory host", { exact: true }),
  ).toBeVisible();
  await expect(sections.getByRole("link", /^Language model/)).toHaveCount(0);
  await expect(sections.getByRole("link", /^Discord/)).toHaveCount(0);

  // Act
  await screen.getByLabel("Search settings").fill("chat control");

  // Assert
  await expect(screen.getByText("No settings match “chat control”.")).toBeVisible();
  await app.screenshot("chat-control-approved-client");
});

const OBSERVATION_ATTEMPTS = 100;

/** The host settings at `path` once `until` holds, read again after each short pause. */
async function settingsWhen<Settings>(
  baseUrl: string | undefined,
  path: string,
  until: (settings: Settings) => boolean,
) {
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt++) {
    const response = await fetch(new URL(path, baseUrl));
    const read = (await response.json()) as Result<Settings>;
    assert(read.ok, JSON.stringify(read));
    if (until(read.value)) return read.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${path} did not reach its condition.`);
}

/** Chat control On and serving, with the participant allowed in the fixture's channel. */
async function operatingChatControl(
  baseUrl: string | undefined,
  allowed = { users: ["200000000000000001"], channels: ["400000000000000002"] },
) {
  const project = await firstProject(baseUrl);
  await completeChatControl(baseUrl);
  const discord = await discordSettings(baseUrl);
  assert(discord.ok);
  const access = await hostCall(baseUrl, "PUT", "/api/chat-control/discord/access", {
    revision: discord.value.access.revision,
    users: allowed.users,
    channels: allowed.channels.map((channelId) => ({ channelId, projectIds: [project.id] })),
  });
  assert(access.ok, JSON.stringify(access));
  const on = await hostCall(baseUrl, "PUT", "/api/chat-control/enabled", { enabled: true });
  assert(on.ok, JSON.stringify(on));
  await settingsWhen<DiscordSettings>(
    baseUrl,
    "/api/chat-control/discord",
    (settings) => settings.commandSetup?.outcome === "registered",
  );
}

test("replacing the bot token after Chat control operated warns that another bot's token replaces it", async ({
  app,
  screen,
}) => {
  // Arrange
  await operatingChatControl(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  const botCard = screen.getByRole("region", "Bot");
  await expect(botCard.getByText("Factory bot", { exact: true })).toBeVisible();

  // Act
  await botCard.getByRole("button", "Replace the bot token").tap();
  await botCard.getByLabel("Bot token").fill("another-bot-token");

  // Assert
  await expect(screen.getByText("A token from another bot replaces Factory bot")).toBeVisible();
  await expect(botCard.getByRole("button", "Cancel")).toBeVisible();
  await app.screenshot("chat-discord-token-replacement");
});

test("an actual conversation failure shows on the Language model page and marks its navigation item", async ({
  app,
  screen,
}) => {
  // Arrange
  provider.state.failure = 500;
  await operatingChatControl(app.baseUrl);
  await discord(app.baseUrl).invoke();
  await settingsWhen<ChatModelSettings>(
    app.baseUrl,
    "/api/chat-control/model",
    (settings) => settings.runtimeProblem !== null,
  );

  // Act
  await app.open("/settings/chat-control/model");

  // Assert
  await expect(screen.getByText("Not answering", { exact: true })).toBeVisible();
  await expect(screen.getByText("Chat replies are failing")).toBeVisible();
  await screen.getByRole("button", /^Technical details/).tap();
  await expect(screen.getByText(/The provider answered HTTP 500\./)).toBeVisible();
  await expect(
    screen
      .getByRole("navigation", "Settings sections")
      .getByRole("link", "Language model, failing", { exact: true }),
  ).toBeVisible();
  await app.screenshot("chat-model-runtime-problem");
});

type FixtureMessage = { channelId: string; content: string; customId: string | null };

/** The messages the controlled Discord created once `until` holds, read again after short pauses. */
async function messagesWhen(
  baseUrl: string | undefined,
  until: (messages: FixtureMessage[]) => boolean,
) {
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt++) {
    const messages = await discord(baseUrl).messages();
    if (until(messages)) return messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The controlled Discord did not create the expected messages.");
}

/** A status card: an accepted Start's only message, edited as its Run changes. */
const CARD = /^\*\*Run #(\d+) · [^\n]+\*\* · (?:🟢|💤|✅|🗄️) /;
const cards = (messages: FixtureMessage[]) =>
  messages.filter((message) => CARD.test(message.content));

/**
 * A participant's Start of `prompt`, confirmed with its button after Discord was told to meet the
 * next message creates with `faults`. Returns the thread and the number of cards before it.
 */
async function confirmedStart(baseUrl: string | undefined, prompt: string, faults: MessageFault[]) {
  const project = await firstProject(baseUrl);
  const flows = (await (await fetch(new URL("/api/flows", baseUrl))).json()) as Result<
    { id: string; name: string; readiness: { ready: boolean } }[]
  >;
  assert(flows.ok);
  const flow = flows.value.find((entry) => entry.name === "Demo · Focused change")!;
  await operatingChatControl(baseUrl);
  provider.state.toolCall = {
    name: "start_run",
    input: { projectId: project.id, flowId: flow.id, prompt, promptSource: "requester-message" },
  };
  const { id: thread } = await discord(baseUrl).invoke({ content: `start: ${prompt}` });
  const messages = await messagesWhen(baseUrl, (created) =>
    created.some((message) => message.channelId === thread && message.customId !== null),
  );
  const { customId } = messages.find(
    (message) => message.channelId === thread && message.customId !== null,
  )!;
  const before = cards(messages).length;
  await discord(baseUrl).fault({ faults });
  await discord(baseUrl).click({ thread, customId: customId! });
  return { thread, before };
}

/** The ID of the Run the latest status card in `thread` names by its number. */
async function cardRunId(baseUrl: string | undefined, thread: string) {
  const messages = await messagesWhen(baseUrl, (created) =>
    cards(created).some((message) => message.channelId === thread),
  );
  const number = Number(
    CARD.exec(
      cards(messages)
        .filter((message) => message.channelId === thread)
        .at(-1)!.content,
    )![1],
  );
  const navigation = (await (
    await fetch(new URL("/api/run-navigation", baseUrl))
  ).json()) as Result<{ id: string; number: number | null }[]>;
  assert(navigation.ok);
  return navigation.value.find((entry) => entry.number === number)!.id;
}

/**
 * A participant's Start, confirmed with its button, whose status card create Discord performed but
 * whose answers were lost, also for both re-attempts under its nonce: Factory owes a card it
 * cannot prove either way. Afterwards Discord's nonce uniqueness window passes.
 */
async function unknownCard(baseUrl: string | undefined) {
  const { thread, before } = await confirmedStart(
    baseUrl,
    "UI card create journey · Tidy the project picker",
    ["lost", "lost", "lost"],
  );
  await settingsWhen<DiscordSettings>(baseUrl, "/api/chat-control/discord", (settings) =>
    settings.delivery.problems.some((problem) => problem.state === "unknown"),
  );
  await discord(baseUrl).nonceWindow();
  return { before, runId: await cardRunId(baseUrl, thread) };
}

/**
 * Opens Settings → Discord at the Delivery row whose Retry is named `retry`, with the navigation
 * item marked, and returns that Retry button.
 */
async function deliveryProblem(app: App, screen: Screen, retry: string, state: string) {
  await app.open("/settings/chat-control/discord");
  const delivery = screen.getByRole("region", "Delivery");
  await expect(delivery.getByText(state, { exact: true })).toBeVisible();
  await expect(
    screen
      .getByRole("navigation", "Settings sections")
      .getByRole("link", "Discord, failing", { exact: true }),
  ).toBeVisible();
  return delivery.getByRole("button", retry);
}

test("the host retries a status card Discord may already show only after a duplicate warning, and the Start is not repeated", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { before, runId } = await unknownCard(app.baseUrl);
  startedRuns.push(runId);
  const retry = await deliveryProblem(app, screen, "Retry the status card", "Unknown");
  await app.screenshot("chat-discord-delivery-unknown");
  await retry.tap();
  const warning = screen.getByRole("alertdialog", "Retry this message?");
  await expect(
    warning.getByText("Discord may already show it, so it could appear twice."),
  ).toBeVisible();
  // The dialog fades in; the Run sidebar's progress indicators never settle.
  await browser.evaluate(
    "Promise.all([...document.querySelectorAll('[role=alertdialog]')].flatMap((element) => element.getAnimations()).map((animation) => animation.finished))",
  );
  await app.screenshot("chat-discord-delivery-retry-warning");

  // Act
  await warning.getByRole("button", "Retry", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("region", "Delivery")).toHaveCount(0);
  await messagesWhen(app.baseUrl, (created) => cards(created).length >= before + 2);
  const navigation = (await (
    await fetch(new URL("/api/run-navigation", app.baseUrl))
  ).json()) as Result<{ id: string; title: string }[]>;
  assert(navigation.ok);
  assert.deepStrictEqual(
    navigation.value
      .filter((entry) => entry.title === "UI card create journey · Tidy the project picker")
      .map((entry) => entry.id),
    [runId],
  );
  await app.screenshot("chat-discord-delivery-retried");
});

test("the host retries the status card Discord refused in a locked thread once a moderator unlocked it", async ({
  app,
  screen,
}) => {
  // Arrange
  const { thread } = await confirmedStart(
    app.baseUrl,
    "UI card journey · Align the Run header",
    [],
  );
  const runId = await cardRunId(app.baseUrl, thread);
  await discord(app.baseUrl).thread({ thread, state: "locked" });
  // Archiving the Run changes its card; Discord refuses the edit in the locked thread.
  const archived = await hostCall(app.baseUrl, "POST", `/api/runs/${runId}/archive`, undefined);
  assert(archived.ok, JSON.stringify(archived));
  await settingsWhen<DiscordSettings>(app.baseUrl, "/api/chat-control/discord", (settings) =>
    settings.delivery.problems.some(
      (problem) => problem.purpose === "status-card" && problem.state === "failed",
    ),
  );
  const retry = await deliveryProblem(app, screen, "Retry the status card", "Failed");
  await app.screenshot("chat-discord-status-card-failed");
  await discord(app.baseUrl).thread({ thread, state: "unlocked" });

  // Act
  await retry.tap();

  // Assert
  await expect(retry).toHaveCount(0);
  const messages = await messagesWhen(app.baseUrl, (created) =>
    created.some(
      (message) =>
        message.channelId === thread &&
        /^\*\*Run [^\n]+\*\* · 🗄️ Archived · /.test(message.content),
    ),
  );
  assert.strictEqual(
    messages.filter((message) => message.channelId === thread && CARD.test(message.content)).length,
    1,
  );
  await app.screenshot("chat-discord-status-card-retried");
});

test("the host retries a completion notice after unlocking its Discord thread", async ({
  app,
  screen,
}) => {
  // Arrange
  const { thread } = await confirmedStart(
    app.baseUrl,
    "UI completion journey · Align the header",
    [],
  );
  const runId = await cardRunId(app.baseUrl, thread);
  await discord(app.baseUrl).thread({ thread, state: "locked" });
  const settled = await hostCall(app.baseUrl, "POST", `/api/runs/${runId}/settle`, {
    stopWorkers: true,
  });
  assert(settled.ok, JSON.stringify(settled));
  await settingsWhen<DiscordSettings>(app.baseUrl, "/api/chat-control/discord", (settings) =>
    settings.delivery.problems.some(
      (problem) => problem.purpose === "completion" && problem.state === "failed",
    ),
  );
  await app.open("/settings/chat-control/discord");
  const delivery = screen.getByRole("region", "Delivery");
  const retry = delivery.getByRole("button", "Retry the completion notice");
  await expect(delivery.getByText("Completion notice", { exact: true })).toBeVisible();
  await app.screenshot("chat-discord-completion-failed");
  await discord(app.baseUrl).thread({ thread, state: "unlocked" });

  // Act
  await retry.tap();

  // Assert
  await expect(retry).toHaveCount(0);
  await messagesWhen(app.baseUrl, (messages) =>
    messages.some(
      (message) =>
        message.channelId === thread &&
        message.content.endsWith("Reply here to inspect the result or choose what to do next."),
    ),
  );
});

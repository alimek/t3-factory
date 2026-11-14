import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  ChatModelSettings,
  DiscordSettings,
  Result,
} from "../packages/contracts/src/index.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";

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

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1000 });
  provider = await controlledProvider();
});

afterEach(async ({ app }) => {
  // Journeys share one fixture; a later journey must start with Chat control Off.
  const off = await hostCall(app.baseUrl, "PUT", "/api/chat-control/enabled", { enabled: false });
  assert(off.ok, JSON.stringify(off));
  await provider.close();
});

async function chatModelSettings(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/chat-control/model", baseUrl));
  return (await response.json()) as Result<ChatModelSettings>;
}

test("the host saves a keyed Language model, tests the saved connection and never sees the key again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/settings/chat-control/model");
  await expect(screen.getByText("Chat control is Off")).toBeVisible();
  const connection = screen.getByRole("region", "Language model connection");
  await connection.getByRole("button", /^Provider: /).tap();
  await screen.getByRole("menuitemradio", /^OpenAI-compatible/).tap();
  await connection.getByLabel("Base URL").fill(provider.baseUrl);
  await connection.getByLabel("Model").fill("ui-model");
  await connection.getByLabel("Key (optional)").fill("sk-ui-journey");
  await connection.getByRole("button", "Save", { exact: true }).tap();
  await expect(connection.getByText(/^Saved .* · revision \d+\.$/)).toBeVisible();
  await app.screenshot("chat-model-saved");

  // Act
  await screen
    .getByRole("region", "Language model test")
    .getByRole("button", "Test saved connection")
    .tap();

  // Assert
  await expect(screen.getByText(/^Latest Test succeeded · /)).toBeVisible();
  assert.deepStrictEqual(
    provider.requests.map((headers) => headers.authorization),
    ["Bearer sk-ui-journey"],
  );
  await screen.getByText(/^A Test is dated evidence for one saved configuration/).scrollIntoView();
  await app.screenshot("chat-model-tested");
  await browser.reload();
  await expect(screen.getByRole("radio", "Keep saved key")).toBeChecked();
  await expect(
    screen.getByRole("region", "Language model connection").getByLabel("Base URL"),
  ).toHaveValue(provider.baseUrl);
  const settings = await chatModelSettings(app.baseUrl);
  expect(settings).toMatchObject({ ok: true, value: { configuration: { keyConfigured: true } } });
  assert(!JSON.stringify(settings).includes("sk-ui-journey"));
});

test("leaving the Language model page with unsaved edits asks before discarding them", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/settings/chat-control/model");
  const connection = screen.getByRole("region", "Language model connection");
  await connection.getByLabel("Model").fill("unsaved-model");
  await expect(connection.getByText("Unsaved changes.")).toBeVisible();

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
async function controlledDiscord(baseUrl: string | undefined) {
  const response = await fetch(new URL("/__fixture/discord", baseUrl), { method: "POST" });
  return (await response.json()) as {
    bot: { token: string; applicationId: string };
    sessions: { token: string | null; ready: boolean; closed: boolean }[];
  };
}

async function discordSettings(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/chat-control/discord", baseUrl));
  return (await response.json()) as Result<DiscordSettings>;
}

test("the host saves the Discord connection, checks it over the Gateway and never sees the token again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { bot } = await controlledDiscord(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  await expect(screen.getByText("Chat control is Off")).toBeVisible();
  const connection = screen.getByRole("region", "Discord connection");
  await connection.getByLabel("Application ID").fill(bot.applicationId);
  await connection.getByLabel("Public Key").fill("ab".repeat(32));
  await connection.getByLabel("Bot token").fill(bot.token);
  await connection.getByRole("button", "Save", { exact: true }).tap();
  await expect(connection.getByText(/^Saved .* · revision \d+\.$/)).toBeVisible();
  await app.screenshot("chat-discord-saved");

  // Act
  await screen
    .getByRole("region", "Discord connection check")
    .getByRole("button", "Check saved connection")
    .tap();

  // Assert
  await expect(screen.getByText(/^Latest check verified · /)).toBeVisible();
  const discord = await controlledDiscord(app.baseUrl);
  assert.deepStrictEqual(discord.sessions, [{ token: bot.token, ready: true, closed: true }]);
  await screen.getByText(/^A passing check shows that Discord accepted the token/).scrollIntoView();
  await app.screenshot("chat-discord-checked");
  await browser.reload();
  await expect(screen.getByRole("radio", "Keep saved token")).toBeChecked();
  const settings = await discordSettings(app.baseUrl);
  expect(settings).toMatchObject({
    ok: true,
    value: { configuration: { applicationId: bot.applicationId, tokenConfigured: true } },
  });
  assert(!JSON.stringify(settings).includes(bot.token));
});

test("leaving the Discord page with unsaved connection edits asks before discarding them", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/settings/chat-control/discord");
  const connection = screen.getByRole("region", "Discord connection");
  await connection.getByLabel("Public Key").fill("cd".repeat(32));
  await expect(connection.getByText("Unsaved changes.")).toBeVisible();

  // Act
  await screen
    .getByRole("navigation", "Settings sections")
    .getByRole("link", "Language model", { exact: true })
    .tap();

  // Assert
  await expect(
    screen.getByRole("dialog", "Discard unsaved Discord connection changes?"),
  ).toBeVisible();
  // Hovering waits for the dialog's opening zoom to settle before the evidence frame.
  await screen.getByRole("button", "Keep editing").hover();
  await app.screenshot("chat-discord-discard-guard");
  await screen.getByRole("button", "Keep editing").tap();
  await expect(connection.getByLabel("Public Key")).toHaveValue("cd".repeat(32));
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
    applicationId: bot.applicationId,
    publicKey: "ab".repeat(32),
    token: { kind: "replace", value: bot.token },
    applicationChangeConfirmed: false,
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

test("the host saves Access on its own while connection edits stay unsaved", async ({
  app,
  screen,
}) => {
  // Arrange
  const project = await firstProject(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  await screen
    .getByRole("region", "Discord connection")
    .getByLabel("Public Key")
    .fill("ef".repeat(32));
  const access = screen.getByRole("region", "Access");
  await expect(access.getByText("Nobody can use Chat control yet")).toBeVisible();
  await access.getByLabel("Allowed user IDs").fill("200000000000000001");
  await access.getByRole("button", "Add channel").tap();
  const channel = access.getByRole("group", "Allowed channel 1");
  await channel.getByLabel("Channel ID").fill("400000000000000002");
  await channel.getByRole("checkbox", project.title).tap();

  // Act
  await access.getByRole("button", "Save", { exact: true }).tap();

  // Assert
  await expect(access.getByText(/^Saved .* · revision 1\.$/)).toBeVisible();
  await expect(
    screen.getByRole("region", "Discord connection").getByText("Unsaved changes."),
  ).toBeVisible();
  const settings = await discordSettings(app.baseUrl);
  expect(settings).toMatchObject({
    ok: true,
    value: {
      access: {
        users: ["200000000000000001"],
        channels: [{ channelId: "400000000000000002", projectIds: [project.id] }],
      },
    },
  });
  await access.getByText("Allowed user IDs").scrollIntoView();
  await app.screenshot("chat-discord-access-saved");
});

test("the host turns Chat control On and sees the Gateway connection and command setup separately", async ({
  app,
  screen,
}) => {
  // Arrange
  await completeChatControl(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  const state = screen.getByRole("region", "Chat control state");
  await expect(state.getByText("Chat control is Off")).toBeVisible();

  // Act
  await state.getByRole("button", "Turn On").tap();

  // Assert
  await expect(state.getByText("Chat control is On")).toBeVisible();
  await expect(state.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(state.getByText("/factory reset registered")).toBeVisible();
  const { sessions } = await controlledDiscord(app.baseUrl);
  assert.strictEqual(sessions.filter((session) => !session.closed).length, 1);
  await app.screenshot("chat-discord-on");
});

test("an approved client's Settings has no Chat control group or search entry", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
  await openApproved(app, "/settings/run-titles");
  const sections = screen.getByRole("navigation", "Settings sections");
  await expect(sections.getByRole("link", "Run titles", { exact: true })).toBeVisible();

  // Act
  await screen.getByLabel("Search settings").fill("chat control");

  // Assert
  await expect(screen.getByText("No settings match “chat control”.")).toBeVisible();
  await expect(sections.getByRole("group", "CHAT CONTROL")).toHaveCount(0);
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
async function operatingChatControl(baseUrl: string | undefined) {
  const project = await firstProject(baseUrl);
  await completeChatControl(baseUrl);
  const discord = await discordSettings(baseUrl);
  assert(discord.ok);
  const access = await hostCall(baseUrl, "PUT", "/api/chat-control/discord/access", {
    revision: discord.value.access.revision,
    users: ["200000000000000001"],
    channels: [{ channelId: "400000000000000002", projectIds: [project.id] }],
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

test("an actual conversation failure shows on the Language model page and marks its navigation item", async ({
  app,
  screen,
}) => {
  // Arrange
  provider.state.failure = 500;
  await operatingChatControl(app.baseUrl);
  await fetch(new URL("/__fixture/discord/invoke", app.baseUrl), { method: "POST" });
  await settingsWhen<ChatModelSettings>(
    app.baseUrl,
    "/api/chat-control/model",
    (settings) => settings.runtimeProblem !== null,
  );

  // Act
  await app.open("/settings/chat-control/model");

  // Assert
  const conversations = screen.getByRole("region", "Language model conversations");
  await expect(
    conversations.getByText(/^A conversation failed · .* · revision \d+$/),
  ).toBeVisible();
  await expect(conversations.getByText(/The provider answered HTTP 500\./)).toBeVisible();
  await expect(
    screen
      .getByRole("navigation", "Settings sections")
      .getByRole("link", "Language model, needs attention", { exact: true }),
  ).toBeVisible();
  await conversations.scrollIntoView();
  await app.screenshot("chat-model-runtime-problem");
});

type FixtureMessage = { channelId: string; content: string; customId: string | null };

/** The messages the controlled Discord created once `until` holds, read again after short pauses. */
async function messagesWhen(
  baseUrl: string | undefined,
  until: (messages: FixtureMessage[]) => boolean,
) {
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt++) {
    const response = await fetch(new URL("/__fixture/discord/messages", baseUrl), {
      method: "POST",
    });
    const messages = (await response.json()) as FixtureMessage[];
    if (until(messages)) return messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The controlled Discord did not create the expected messages.");
}

const RECEIPT = "**Start accepted.**";
const receipts = (messages: FixtureMessage[]) =>
  messages.filter((message) => message.content.startsWith(RECEIPT));

/**
 * A participant's Start, confirmed with its button, whose receipt create Discord performed but
 * whose answer was lost: Factory owes a receipt it cannot prove either way.
 */
async function unknownReceipt(baseUrl: string | undefined) {
  const project = await firstProject(baseUrl);
  const flows = (await (await fetch(new URL("/api/flows", baseUrl))).json()) as Result<
    { id: string; name: string; readiness: { ready: boolean } }[]
  >;
  assert(flows.ok);
  const flow = flows.value.find((entry) => entry.name === "Demo · Focused change")!;
  await operatingChatControl(baseUrl);
  const prompt = "UI receipt journey · Tidy the project picker";
  provider.state.toolCall = {
    name: "start_run",
    input: { projectId: project.id, flowId: flow.id, prompt, promptSource: "requester-message" },
  };
  const invoked = await fetch(
    new URL(`/__fixture/discord/invoke?content=${encodeURIComponent(`start: ${prompt}`)}`, baseUrl),
    { method: "POST" },
  );
  const { id: thread } = (await invoked.json()) as { id: string };
  const messages = await messagesWhen(baseUrl, (created) =>
    created.some((message) => message.channelId === thread && message.customId !== null),
  );
  const { customId } = messages.find((message) => message.customId !== null)!;
  const before = receipts(messages).length;
  await fetch(new URL("/__fixture/discord/fault?fault=lost", baseUrl), { method: "POST" });
  await fetch(new URL(`/__fixture/discord/click?thread=${thread}&customId=${customId}`, baseUrl), {
    method: "POST",
  });
  await settingsWhen<DiscordSettings>(baseUrl, "/api/chat-control/discord", (settings) =>
    settings.delivery.problems.some((problem) => problem.state === "unknown"),
  );
  const runId = /Run ID: `([^`]+)`/.exec(
    receipts(await messagesWhen(baseUrl, () => true)).at(-1)!.content,
  )![1]!;
  return { before, runId };
}

test("the host retries an owed receipt Discord may already show only after a duplicate warning, and the Start is not repeated", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { before, runId } = await unknownReceipt(app.baseUrl);
  await app.open("/settings/chat-control/discord");
  const delivery = screen.getByRole("region", "Delivery and actions");
  const receipt = delivery.getByRole("listitem", "Action receipt, Unknown");
  await expect(
    receipt.getByText(
      "Factory cannot tell whether Discord created the message. Retrying may post it twice.",
    ),
  ).toBeVisible();
  await expect(
    screen
      .getByRole("navigation", "Settings sections")
      .getByRole("link", "Discord, needs attention", { exact: true }),
  ).toBeVisible();
  await delivery.scrollIntoView();
  await app.screenshot("chat-discord-delivery-unknown");
  await receipt.getByRole("button", "Retry").tap();
  const warning = screen.getByRole("alertdialog", "Retry a message Discord may already show?");
  await expect(warning.getByText(/the thread may show it twice/)).toBeVisible();
  // The dialog fades in; the Run sidebar's progress indicators never settle.
  await browser.evaluate(
    "Promise.all([...document.querySelectorAll('[role=alertdialog]')].flatMap((element) => element.getAnimations()).map((animation) => animation.finished))",
  );
  await app.screenshot("chat-discord-delivery-retry-warning");

  // Act
  await warning.getByRole("button", "Retry anyway").tap();

  // Assert
  await expect(screen.getByRole("region", "Delivery and actions")).toHaveCount(0);
  const messages = await messagesWhen(
    app.baseUrl,
    (created) => receipts(created).length >= before + 2,
  );
  assert.strictEqual(receipts(messages).at(-1)!.content, receipts(messages).at(-2)!.content);
  const navigation = (await (
    await fetch(new URL("/api/run-navigation", app.baseUrl))
  ).json()) as Result<{ id: string; title: string }[]>;
  assert(navigation.ok);
  assert.deepStrictEqual(
    navigation.value
      .filter((entry) => entry.title === "UI receipt journey · Tidy the project picker")
      .map((entry) => entry.id),
    [runId],
  );
  await app.screenshot("chat-discord-delivery-retried");
  const archived = await hostCall(app.baseUrl, "POST", `/api/runs/${runId}/archive`, undefined);
  assert(archived.ok, JSON.stringify(archived));
});

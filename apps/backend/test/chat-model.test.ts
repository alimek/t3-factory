import { assert, expect, it } from "@effect/vitest";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { factoryHarness } from "./support/factory.ts";
import { controlledModelProvider, unreachableBaseUrl } from "./support/controlled-model.ts";
import { overrideEnvironment } from "./support/reporting-home.ts";
import { chatModelSave, savedChatModel } from "./support/chat-control.ts";

it("an incomplete Language model can be saved while Chat control is Off", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();

  // Act
  const saved = await factory.updateChatModelSettings(
    chatModelSave({ providerKind: "anthropic", baseUrl: null, model: null }),
  );

  // Assert
  assert(saved.ok);
  expect(saved.value.chatControlEnabled).toBe(false);
  expect(saved.value.configuration).toMatchObject({
    providerKind: "anthropic",
    baseUrl: null,
    model: null,
    keyConfigured: false,
    revision: 1,
  });
});

it("a base URL with embedded credentials is rejected and the saved settings stay unchanged", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  const before = await factory.getChatModelSettings();

  // Act
  const saved = await factory.updateChatModelSettings(
    chatModelSave({ baseUrl: "https://user:secret@gateway.example/v1" }),
  );

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues[0]).toMatchObject({
    code: "chat_model_base_url_credentials",
    path: "baseUrl",
  });
  expect(await factory.getChatModelSettings()).toStrictEqual(before);
});

it("Test sends the saved key as a bearer credential to the saved proxy path and records success for that revision", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedChatModel(factory, {
    baseUrl: provider.baseUrl("/proxy/openai/v1"),
    model: "gateway/model-a",
    key: { kind: "replace", value: "sk-saved-key" },
  });

  // Act
  const tested = await factory.testChatModel({ revision: saved.configuration.revision });

  // Assert
  assert(tested.ok);
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]).toMatchObject({
    method: "POST",
    path: "/proxy/openai/v1/chat/completions",
    headers: { authorization: "Bearer sk-saved-key" },
    body: { model: "gateway/model-a" },
  });
  expect(provider.requests[0]!.body).not.toHaveProperty("tools");
  expect(tested.value.latestTest).toMatchObject({ revision: 1, outcome: "succeeded" });
  expect(tested.value.configuration).toStrictEqual(saved.configuration);
});

it("a keyless OpenAI-compatible Test sends no credential even when the server has OpenAI credentials", async (c) => {
  // Arrange
  overrideEnvironment(c, "OPENAI_API_KEY", "sk-environment");
  overrideEnvironment(c, "OPENAI_BASE_URL", "http://127.0.0.1:9/v1");
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedChatModel(factory, { baseUrl: provider.baseUrl() });

  // Act
  const tested = await factory.testChatModel({ revision: saved.configuration.revision });

  // Assert
  assert(tested.ok);
  expect(tested.value.latestTest?.outcome).toBe("succeeded");
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]!.headers.authorization).toBeUndefined();
});

it("a keyless Anthropic Test goes to the saved base URL with a placeholder instead of the server's Anthropic credentials", async (c) => {
  // Arrange
  overrideEnvironment(c, "ANTHROPIC_API_KEY", "sk-ant-environment");
  overrideEnvironment(c, "ANTHROPIC_BASE_URL", "http://127.0.0.1:9/v1");
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedChatModel(factory, {
    providerKind: "anthropic",
    baseUrl: provider.baseUrl("/anthropic/v1"),
    model: "local-model",
  });

  // Act
  const tested = await factory.testChatModel({ revision: saved.configuration.revision });

  // Assert
  assert(tested.ok);
  expect(tested.value.latestTest?.outcome).toBe("succeeded");
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]!.path).toBe("/anthropic/v1/messages");
  expect(provider.requests[0]!.headers["x-api-key"]).toBe("factory-keyless");
});

it("the settings read reports a saved key without returning it", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  await savedChatModel(factory, { key: { kind: "replace", value: "sk-never-returned" } });

  // Act
  const read = await factory.getChatModelSettings();

  // Assert
  assert(read.ok);
  expect(read.value.configuration.keyConfigured).toBe(true);
  expect(JSON.stringify(read)).not.toContain("sk-never-returned");
});

it("a saved key lives only in an owner-only credential file outside SQLite", async (c) => {
  // Arrange
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  const directory = join(harness.processHome, "credentials", "chat-control");

  // Act
  await savedChatModel(factory, { key: { kind: "replace", value: "sk-protected-at-rest" } });

  // Assert
  const [file] = await readdir(directory);
  assert(file);
  expect(await readFile(join(directory, file), "utf8")).toContain("sk-protected-at-rest");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
  await factory.close();
  expect(await readFile(harness.databasePath, "latin1")).not.toContain("sk-protected-at-rest");
});

it("saving with the key left blank keeps the saved key for the next Test", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  await savedChatModel(factory, {
    baseUrl: provider.baseUrl(),
    key: { kind: "replace", value: "sk-kept" },
  });
  const renamed = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: provider.baseUrl(), model: "model-b" }),
  );
  assert(renamed.ok);

  // Act
  const tested = await factory.testChatModel({ revision: 2 });

  // Assert
  assert(tested.ok);
  expect(provider.requests[0]!.headers.authorization).toBe("Bearer sk-kept");
  expect(provider.requests[0]!.body).toMatchObject({ model: "model-b" });
});

it("removing the saved key makes the next Test keyless", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  await savedChatModel(factory, {
    baseUrl: provider.baseUrl(),
    key: { kind: "replace", value: "sk-removed" },
  });
  const removed = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: provider.baseUrl(), key: { kind: "remove" } }),
  );
  assert(removed.ok);
  expect(removed.value.configuration.keyConfigured).toBe(false);

  // Act
  const tested = await factory.testChatModel({ revision: 2 });

  // Assert
  assert(tested.ok);
  expect(provider.requests[0]!.headers.authorization).toBeUndefined();
});

it("changing the base URL while a key is saved is refused until the owner decides what happens to the key", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedChatModel(factory, { key: { kind: "replace", value: "sk-bound" } });

  // Act
  const moved = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: "https://other-gateway.example/v1" }),
  );

  // Assert
  assert(!moved.ok);
  expect(moved.error.issues[0]).toMatchObject({ code: "chat_model_key_destination", path: "key" });
  expect(await factory.getChatModelSettings()).toStrictEqual({ ok: true, value: saved });
});

it("reusing the saved key at a new base URL sends it there", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  await savedChatModel(factory, { key: { kind: "replace", value: "sk-reused" } });
  const moved = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: provider.baseUrl("/moved/v1"), key: { kind: "reuse" } }),
  );
  assert(moved.ok);

  // Act
  const tested = await factory.testChatModel({ revision: 2 });

  // Assert
  assert(tested.ok);
  expect(provider.requests[0]).toMatchObject({
    path: "/moved/v1/chat/completions",
    headers: { authorization: "Bearer sk-reused" },
  });
});

it("a save refused as stale after staging its key leaves the committed key in use across restart", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  await savedChatModel(factory, {
    baseUrl: provider.baseUrl(),
    key: { kind: "replace", value: "sk-committed" },
  });
  const stale = await factory.updateChatModelSettings(
    chatModelSave({
      revision: 0,
      baseUrl: provider.baseUrl(),
      key: { kind: "replace", value: "sk-uncommitted" },
    }),
  );
  assert(!stale.ok);
  expect(stale.error.code).toBe("conflict");
  await factory.close();
  const reopened = await harness.open();

  // Act
  const tested = await reopened.testChatModel({ revision: 1 });

  // Assert
  assert(tested.ok);
  expect(provider.requests.map((request) => request.headers.authorization)).toStrictEqual([
    "Bearer sk-committed",
  ]);
});

it("a replacement key that cannot be stored keeps the previous configuration and key", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  const saved = await savedChatModel(factory, {
    baseUrl: provider.baseUrl(),
    key: { kind: "replace", value: "sk-previous" },
  });
  const directory = join(harness.processHome, "credentials", "chat-control");
  await chmod(directory, 0o500);
  c.onTestFinished(() => chmod(directory, 0o700));

  // Act
  const replaced = await factory.updateChatModelSettings(
    chatModelSave({
      revision: 1,
      baseUrl: provider.baseUrl(),
      model: "model-b",
      key: { kind: "replace", value: "sk-unstored" },
    }),
  );

  // Assert
  assert(!replaced.ok);
  expect(replaced.error.code).toBe("internal");
  expect(await factory.getChatModelSettings()).toStrictEqual({ ok: true, value: saved });
});

it("a reachable-looking but unreachable configuration stays saved and its Test records Factory's own failure", async (c) => {
  // Arrange
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedChatModel(factory, { baseUrl: await unreachableBaseUrl() });

  // Act
  const tested = await factory.testChatModel({ revision: saved.configuration.revision });

  // Assert
  assert(tested.ok);
  expect(tested.value.configuration).toStrictEqual(saved.configuration);
  expect(tested.value.latestTest).toMatchObject({
    revision: 1,
    outcome: "failed",
    message: "Factory could not reach the provider at the saved base URL.",
  });
});

it("a failed Test sends one request without retries and records no provider body, key or URL", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  provider.fail(503, { error: { message: "invalid key sk-echoed-secret for /private/path" } });
  const factory = await (await factoryHarness(c)).open();
  const saved = await savedChatModel(factory, {
    baseUrl: provider.baseUrl("/private/path"),
    key: { kind: "replace", value: "sk-echoed-secret" },
  });

  // Act
  const tested = await factory.testChatModel({ revision: saved.configuration.revision });

  // Assert
  assert(tested.ok);
  expect(provider.requests).toHaveLength(1);
  expect(tested.value.latestTest).toMatchObject({
    outcome: "failed",
    message: "The provider answered HTTP 503.",
  });
  expect(JSON.stringify(tested.value.latestTest)).not.toMatch(
    /sk-echoed-secret|private\/path|invalid key/,
  );
});

it("Test refuses a revision other than the saved one without contacting the provider", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  await savedChatModel(factory, { baseUrl: provider.baseUrl() });
  const changed = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: provider.baseUrl(), model: "model-b" }),
  );
  assert(changed.ok);

  // Act
  const tested = await factory.testChatModel({ revision: 1 });

  // Assert
  assert(!tested.ok);
  expect(tested.error.code).toBe("conflict");
  expect(provider.requests).toHaveLength(0);
});

it("saving a new configuration keeps the earlier Test as dated evidence for its own revision", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const factory = await (await factoryHarness(c)).open();
  await savedChatModel(factory, { baseUrl: provider.baseUrl() });
  assert((await factory.testChatModel({ revision: 1 })).ok);

  // Act
  const changed = await factory.updateChatModelSettings(
    chatModelSave({ revision: 1, baseUrl: provider.baseUrl(), model: "model-b" }),
  );

  // Assert
  assert(changed.ok);
  expect(changed.value.configuration.revision).toBe(2);
  expect(changed.value.latestTest).toMatchObject({ revision: 1, outcome: "succeeded" });
});

it("reopening Factory with a saved configuration sends no request to the provider", async (c) => {
  // Arrange
  const provider = await controlledModelProvider(c);
  const harness = await factoryHarness(c);
  const factory = await harness.open();
  await savedChatModel(factory, {
    baseUrl: provider.baseUrl(),
    key: { kind: "replace", value: "sk-no-probe" },
  });
  await factory.close();

  // Act
  const reopened = await harness.open();

  // Assert
  expect((await reopened.getChatModelSettings()).ok).toBe(true);
  expect(provider.requests).toHaveLength(0);
});

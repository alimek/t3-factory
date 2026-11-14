import { assert, expect, it } from "@effect/vitest";
import type { RunTitleSetting } from "@t3-factory/contracts";
import { prepared } from "./support/prepared-runner.ts";
import { remotePrepared } from "./support/remote-clients.ts";
import {
  cheapTitleModel,
  controlledTitleModel,
  enableRunTitles,
  enableRunTitlesWithCheapModel,
} from "./support/scenarios.ts";

it("an automatic Run started while Generate Run titles is on records a pending generation with the captured model and a 30-second deadline", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  expect(started.value.titleGeneration).toStrictEqual({
    state: "pending",
    reason: null,
    modelLabel: "Codex · GPT 6.1 Sol",
    deadlineAt: new Date(Date.parse(started.value.startedAt) + 30_000).toISOString(),
    automaticTitle: "Improve search",
    generatedTitle: null,
    threadLink: null,
  });
  const navigation = await fixture.f.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value[0]?.titleGeneration).toStrictEqual(started.value.titleGeneration);
});

it("an automatic Run started while Generate Run titles is off records no title generation", async (c) => {
  // Arrange
  const fixture = await prepared(c);

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  expect(started.value.titleGeneration).toBeNull();
});

it("a manually titled Run records no title generation while Generate Run titles is on", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);

  // Act
  const started = await fixture.f.startRun({
    ...fixture.input,
    title: "Search ranking",
    titleProvenance: "manual",
  });

  // Assert
  assert(started.ok);
  expect(started.value.titleGeneration).toBeNull();
});

it("a legacy Start records no title generation while Generate Run titles is on", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const { titleProvenance: _omitted, ...beforeProvenance } = fixture.input;

  // Act
  const started = await fixture.f.startRun(beforeProvenance);

  // Assert
  assert(started.ok);
  expect(started.value.titleProvenance).toBe("legacy");
  expect(started.value.titleGeneration).toBeNull();
});

it("a title model T3 no longer offers skips generation with a diagnostic on the setting while the Run still starts", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const withdraw = await enableRunTitlesWithCheapModel(fixture.f, fixture.t3);
  withdraw();
  const launched = fixture.t3.nextLaunch();

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  expect(started.value.titleGeneration).toMatchObject({
    state: "skipped",
    reason: "T3 does not offer gpt-6.1-luna for Codex.",
    modelLabel: "Codex · gpt-6.1-luna",
  });
  expect(await fixture.f.getRunTitleSetting()).toStrictEqual({
    ok: true,
    value: {
      enabled: true,
      model: cheapTitleModel,
      diagnostic: {
        runId: started.value.id,
        runNumber: 1,
        message: "T3 does not offer gpt-6.1-luna for Codex.",
        recordedAt: started.value.startedAt,
      },
    },
  });
  expect((await launched).title).toContain("Factory #1");
});

it("a prompt with no meaningful text skips generation without a diagnostic", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);

  // Act
  const started = await fixture.f.startRun({ ...fixture.input, input: "...\n?!", title: "..." });

  // Assert
  assert(started.ok);
  expect(started.value.titleGeneration).toMatchObject({
    state: "skipped",
    reason: "The prompt has no text to title.",
  });
  const setting = await fixture.f.getRunTitleSetting();
  assert(setting.ok);
  expect(setting.value.diagnostic).toBeNull();
});

it("a replayed Start keeps its pending generation and decides nothing again after the title model is withdrawn", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const withdraw = await enableRunTitlesWithCheapModel(fixture.f, fixture.t3);
  const first = await fixture.f.startRun(fixture.input);
  assert(first.ok);
  withdraw();

  // Act
  const replayed = await fixture.f.startRun(fixture.input);

  // Assert
  assert(replayed.ok);
  expect(replayed.value.id).toBe(first.value.id);
  expect(replayed.value.titleProvenance).toBe("automatic");
  expect(replayed.value.titleGeneration).toStrictEqual(first.value.titleGeneration);
  expect(replayed.value.titleGeneration?.state).toBe("pending");
  const setting = await fixture.f.getRunTitleSetting();
  assert(setting.ok);
  expect(setting.value.diagnostic).toBeNull();
});

it("enabling Generate Run titles with a model T3 does not offer is rejected and leaves the setting off", async (c) => {
  // Arrange
  const fixture = await prepared(c);

  // Act
  const result = await fixture.f.updateRunTitleSetting({ enabled: true, model: cheapTitleModel });

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]).toMatchObject({
    code: "model_unavailable",
    path: "model.modelId",
  });
  expect(await fixture.f.getRunTitleSetting()).toStrictEqual({
    ok: true,
    value: { enabled: false, model: null, diagnostic: null },
  });
});

it("enabling Generate Run titles with a provider instance T3 does not offer is rejected", async (c) => {
  // Arrange
  const fixture = await prepared(c);

  // Act
  const result = await fixture.f.updateRunTitleSetting({
    enabled: true,
    model: { ...controlledTitleModel, providerInstanceId: "claude-main" },
  });

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]).toMatchObject({
    code: "provider_unavailable",
    path: "model.providerInstanceId",
  });
});

it("an approved client cannot change Generate Run titles on the host", async (c) => {
  // Arrange
  const { server, laptop } = await remotePrepared(c);

  // Act
  const reply = await laptop.send("PUT", "/api/settings/run-titles", {
    enabled: true,
    model: controlledTitleModel,
  });

  // Assert
  expect(reply.status).toBe(403);
  assert(!reply.body.ok);
  expect(reply.body.error.code).toBe("host_only");
  expect(await server.factory.getRunTitleSetting()).toStrictEqual({
    ok: true,
    value: { enabled: false, model: null, diagnostic: null },
  });
});

it("an approved client reads Generate Run titles with its latest diagnostic", async (c) => {
  // Arrange
  const { server, laptop, t3, input } = await remotePrepared(c);
  const withdraw = await enableRunTitlesWithCheapModel(server.factory, t3);
  withdraw();
  const started = await server.factory.startRun(input);
  assert(started.ok);

  // Act
  const reply = await laptop.send<RunTitleSetting>("GET", "/api/settings/run-titles");

  // Assert
  assert(reply.body.ok);
  expect(reply.body.value).toStrictEqual({
    enabled: true,
    model: cheapTitleModel,
    diagnostic: {
      runId: started.value.id,
      runNumber: 1,
      message: "T3 does not offer gpt-6.1-luna for Codex.",
      recordedAt: started.value.startedAt,
    },
  });
});

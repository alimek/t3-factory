import { assert, expect, it } from "@effect/vitest";
import type { RunTitleSetting } from "@t3-factory/contracts";
import { prepared } from "./support/prepared-runner.ts";
import { remotePrepared } from "./support/remote-clients.ts";
import { imageRequest } from "./support/run-images.ts";
import {
  capabilityFromLaunchPrompt,
  cheapTitleModel,
  controlledTitleModel,
  enableRunTitles,
  enableRunTitlesWithCheapModel,
  holdTitleThreadLaunch,
  loseTitleThreadLaunchReply,
  resultReported,
  titleGenerationEnded,
  titleGenerationLaunched,
  titleThreadEnds,
  titleThreadLaunched,
  titleThreadLaunchRecorded,
  titleThreadReference,
  titleThreadStopRequested,
  titleThreadStops,
  withdrawTitleModelAfterStartCheck,
  workerAtWork,
  worktreeFanOutFlow,
} from "./support/scenarios.ts";

it("an automatic Run started while Generate Run titles is on records a pending generation with the captured model and a 30-second deadline", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  c.onTestFinished(holdTitleThreadLaunch(fixture.t3));

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
  await titleGenerationLaunched(fixture.world, first.value.id);
  const launched = await fixture.f.getRun(first.value.id);
  assert(launched.ok);
  withdraw();

  // Act
  const replayed = await fixture.f.startRun(fixture.input);

  // Assert
  assert(replayed.ok);
  expect(replayed.value.id).toBe(first.value.id);
  expect(replayed.value.titleProvenance).toBe("automatic");
  expect(replayed.value.titleGeneration).toStrictEqual(launched.value.titleGeneration);
  expect(replayed.value.titleGeneration?.state).toBe("pending");
  expect(fixture.t3.launches.size).toBe(2);
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

it("a pending generation launches one top-level title thread in the Project checkout of a worktree Run with the captured model", async (c) => {
  // Arrange
  const fixture = await prepared(c, worktreeFanOutFlow);
  await enableRunTitles(fixture.f);

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  const launch = await titleGenerationLaunched(fixture.world, started.value.id);
  expect(launch).toStrictEqual({
    environmentId: fixture.t3.environmentId,
    projectId: fixture.project.projectId,
    clientRequestId: expect.any(String),
    title: `Factory title · Run #1 · ${capabilityFromLaunchPrompt(launch)}`,
    workspaceStrategy: { type: "root" },
    interactionMode: "default",
    modelSelection: {
      instanceId: "codex-main",
      model: "gpt-6.1-sol",
      options: { reasoning: "low" },
    },
    message: expect.stringContaining("Improve search\nKeep it accessible."),
  });
  expect(launch.message).toContain("at most 120");
});

it("a title thread's prompt carries image labels as text and its launch attaches no image", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const start = await imageRequest(fixture);

  // Act
  const started = await fixture.f.startRun(start);

  // Assert
  assert(started.ok);
  const launch = await titleGenerationLaunched(fixture.world, started.value.id);
  expect(launch.message).toContain(
    "<run-prompt>\nFix the header shown in [Image 1: screenshot.png].\nKeep the footer.\n</run-prompt>",
  );
  expect(launch.attachments).toBeUndefined();
});

it("the Flow's worker launches while the title thread's launch is still unanswered", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  c.onTestFinished(holdTitleThreadLaunch(fixture.t3));
  const workerLaunch = fixture.t3.nextLaunch();

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  expect((await workerLaunch).title).toMatch(/^Factory #1 · 1 /);
  const run = await fixture.f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.titleGeneration).toMatchObject({ state: "pending", threadLink: null });
});

it("a title model T3 withdrew after Start is skipped just before dispatch with a diagnostic and launches no title thread", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const withdraw = await enableRunTitlesWithCheapModel(fixture.f, fixture.t3);
  withdrawTitleModelAfterStartCheck(fixture.t3, withdraw);

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  expect(started.value.titleGeneration?.state).toBe("pending");
  const run = await titleGenerationEnded(fixture.world, started.value.id);
  expect(run.titleGeneration).toMatchObject({
    state: "skipped",
    reason: "T3 does not offer gpt-6.1-luna for Codex.",
    threadLink: null,
  });
  const setting = await fixture.f.getRunTitleSetting();
  assert(setting.ok);
  expect(setting.value.diagnostic).toMatchObject({
    runId: started.value.id,
    message: "T3 does not offer gpt-6.1-luna for Codex.",
  });
  expect([...fixture.t3.launches.values()].map((launch) => launch.payload.title)).toStrictEqual([
    "Factory #1 · 1 Entry worker",
  ]);
});

it("a title thread launch T3 rejects records the generation failed and keeps the automatic title", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  fixture.t3.rejectLaunch = true;

  // Act
  const started = await fixture.f.startRun(fixture.input);

  // Assert
  assert(started.ok);
  await titleThreadLaunchRecorded(fixture.t3);
  const run = await titleGenerationEnded(fixture.world, started.value.id);
  expect(run.titleGeneration).toMatchObject({
    state: "failed",
    reason: "T3 rejected the title thread launch.",
  });
  expect(run.title).toBe("Improve search");
  expect(run.titleProvenance).toBe("automatic");
});

it("a Rename while the title is pending drops the generation even when it keeps the automatic title", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);

  // Act
  const renamed = await fixture.f.renameRun(started.value.id, { title: "Improve search" });

  // Assert
  assert(renamed.ok);
  expect(renamed.value.title).toBe("Improve search");
  expect(renamed.value.titleProvenance).toBe("manual");
  expect(renamed.value.titleGeneration).toMatchObject({
    state: "dropped",
    reason: "The Run was renamed before a generated title arrived.",
  });
});

it("a Run whose title is still pending settles once its worker finished, with no attention and its title thread untouched", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const worker = await workerAtWork(fixture.world, fixture.input);
  await titleGenerationLaunched(fixture.world, worker.runId);
  await resultReported(fixture.world, worker);

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(worker.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(run.value.titleGeneration?.state).toBe("pending");
  expect(run.value.attention).toStrictEqual([]);
  expect(fixture.t3.settlements).toStrictEqual([{ threadId: worker.threadId }]);
  expect(fixture.t3.threadStops).toStrictEqual([]);
  expect(await fixture.f.listAttention()).toStrictEqual({ ok: true, value: [] });
});

it("turning Generate Run titles off leaves a pending generation to finish with its captured model", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  c.onTestFinished(holdTitleThreadLaunch(fixture.t3));
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);

  // Act
  const disabled = await fixture.f.updateRunTitleSetting({ enabled: false, model: null });

  // Assert
  assert(disabled.ok);
  const run = await fixture.f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.titleGeneration).toMatchObject({
    state: "pending",
    modelLabel: "Codex · GPT 6.1 Sol",
  });
});

it("Archive cancels a pending title generation in its transaction and requests one Stop of the title thread", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const thread = await titleThreadLaunched(fixture.world, fixture.input);
  const stopped = titleThreadStopRequested(fixture.t3);

  // Act
  const archived = await fixture.f.archiveRun(thread.runId);

  // Assert
  assert(archived.ok);
  expect(archived.value.title).toBe("Improve search");
  expect(archived.value.titleGeneration).toMatchObject({
    state: "cancelled",
    reason: "The Run was archived before a generated title arrived.",
  });
  expect(await stopped).toStrictEqual({
    threadId: titleThreadReference(fixture.t3).threadId,
    clientRequestId: expect.any(String),
  });
});

it("confirmed manual settlement cancels a pending title generation as it closes the gate and requests one Stop of the title thread", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const thread = await titleThreadLaunched(fixture.world, fixture.input);
  const stopped = titleThreadStopRequested(fixture.t3);

  // Act
  const settling = await fixture.f.settleRun(thread.runId, { stopWorkers: true });

  // Assert
  assert(settling.ok);
  expect(settling.value.run.titleGeneration).toMatchObject({
    state: "cancelled",
    reason: "The Run was settled manually before a generated title arrived.",
  });
  expect((await stopped).threadId).toBe(titleThreadReference(fixture.t3).threadId);
});

it("a restart after a lost title thread launch reply binds the launched thread by its provenance without launching another", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  loseTitleThreadLaunchReply(fixture.t3);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  await titleThreadLaunchRecorded(fixture.t3);
  await fixture.f.close();

  // Act
  const restored = await fixture.h.open({ t3: fixture.t3, connectionRetryMs: 60_000 });

  // Assert
  const run = await restored.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.titleGeneration).toMatchObject({
    state: "pending",
    threadLink: expect.stringContaining(titleThreadReference(fixture.t3).threadId),
  });
  expect(fixture.t3.launchCalls).toBe(2);
});

it("a title thread that finishes without a valid title records failed quietly, keeps the automatic title and settles the thread", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const thread = await titleThreadLaunched(fixture.world, fixture.input);
  await titleThreadEnds(fixture.t3);

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(thread.runId);
  assert(run.ok);
  expect(run.value.titleGeneration).toMatchObject({
    state: "failed",
    reason: "The title thread finished without submitting a valid title.",
  });
  expect(run.value.title).toBe("Improve search");
  expect(run.value.titleProvenance).toBe("automatic");
  expect(run.value.attention).toStrictEqual([]);
  expect(await fixture.f.listAttention()).toStrictEqual({ ok: true, value: [] });
  expect(fixture.t3.settlements).toStrictEqual([
    { threadId: titleThreadReference(fixture.t3).threadId },
  ]);
  expect(titleThreadStops(fixture.t3)).toStrictEqual([]);
});

it("after a title is applied, Factory requests one keyed Stop of the title thread that may still be running", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  await enableRunTitles(fixture.f);
  const thread = await titleThreadLaunched(fixture.world, fixture.input);
  const applied = await fixture.f.runtime.title({
    arguments: { titleGenerationId: thread.titleGenerationId, title: "Search ranking" },
  });
  expect(applied.code).toBe("TITLE_APPLIED");

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  expect(titleThreadStops(fixture.t3)).toStrictEqual([
    { threadId: titleThreadReference(fixture.t3).threadId, clientRequestId: expect.any(String) },
  ]);
  expect(fixture.t3.settlements).toStrictEqual([]);
});

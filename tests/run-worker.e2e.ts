import assert from "node:assert/strict";
import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { listAgentDefinitions, readAgentDefinition } from "./support/agents.ts";
import { workerEvent } from "./support/worker.ts";
import { openComposerWithFlow } from "./support/composer.ts";

beforeEach(async ({ app }) => {
  await workerEvent(app.baseUrl, "prepare");
});

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1100 });
});

test("saved worker settings persist after reload", async ({ app, screen, browser }) => {
  // Arrange
  const agents = await listAgentDefinitions(app.baseUrl);
  const agent = agents.find((a) => a.name === "Demo · Product engineer");
  assert(agent);
  await app.open(`/studio/agents/${agent.id}`);
  await screen
    .getByLabel("Prompt", { exact: true })
    .fill("Implement focused changes and report the result directly.");

  // Act
  await screen.getByRole("button", "Save", { exact: true }).tap();

  // Assert
  await expect
    .poll(() => readAgentDefinition(app.baseUrl, agent.id))
    .toMatchObject({
      revision: agent.revision + 1,
      prompt: "Implement focused changes and report the result directly.",
    });
  await expect(screen.getByRole("button", "Duplicate", { exact: true })).toBeEnabled();
  await browser.reload();
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Implement focused changes and report the result directly.",
  );
  await app.screenshot("worker-only-save-reloaded");
});

test("Start launches the Run conversation and a direct worker", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Focused change");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("UI direct worker launch");
  await expect(screen.getByRole("button", "Start", { exact: true })).toBeEnabled();
  await app.screenshot("direct-start-ready");

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(
    screen.getByRole("heading", "UI direct worker launch", { exact: true }),
  ).toBeVisible();
  const created = await findRun(app.baseUrl, "UI direct worker launch");
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, created.id)).threadBindings.length)
    .toBe(1);
  const run = await readHistoryRun(app.baseUrl, created.id);
  expect(run.snapshot.executionContract).toBe("run-worker-v1");
  expect(run.snapshot.coordinationInstructionVersion).toBe(5);
  expect(run.threadBindings.map((b) => b.role)).toEqual(["worker"]);
  expect(run.activations).toHaveLength(1);
  expect(run.runCoordinator?.threadId).not.toBe(run.threadBindings[0]?.threadId);
  await browser.reload();
  await expect(screen.getByRole("link", "Open Run conversation", { exact: true })).toHaveAttribute(
    "href",
    run.runCoordinator!.link!,
  );
  await expect(
    screen
      .getByRole("region", "Block activations")
      .getByRole("link", "Open worker in T3", { exact: true }),
  ).toHaveAttribute("href", run.threadBindings[0]!.link!);
  await app.screenshot("direct-root-worker-after-reload");
});

test("reloading a waiting worker retains its exact question link", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Needs input · Agent asked about empty-state wording",
  );
  const run = await readHistoryRun(app.baseUrl, found.id);
  const question = run.attention.find((a) => a.kind === "conversation-waiting" && !a.settledAt);
  assert(question);
  await app.open(`/runs/${run.id}`);

  // Act
  await browser.reload();

  // Assert
  const input = screen.getByRole("region", "Needs input");
  await expect(input).toContainText("preferred tone");
  await expect(input).toContainText("Worker ·");
  await expect(input.getByRole("link", "Open in T3", { exact: true })).toHaveAttribute(
    "href",
    question.link!,
  );
  expect((await readHistoryRun(app.baseUrl, run.id)).activations).toEqual(run.activations);
  await app.screenshot("worker-question-after-reload");
});

test("a native worker reply completes the same activation and preserves its waiting history", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Needs input · Agent asked about empty-state wording",
  );
  const before = await readHistoryRun(app.baseUrl, found.id);
  await app.open(`/runs/${found.id}`);

  // Act — simulate the ordinary reply in the exact native worker conversation.
  await workerEvent(app.baseUrl, "answer");

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).outcome)
    .toBe("finished");
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.activations.map((a) => a.id)).toEqual(before.activations.map((a) => a.id));
  expect(saved.threadBindings).toEqual(before.threadBindings);
  expect(saved.executions.map((e) => e.executionId)).toContain("ui-worker-reply");
  expect(saved.reports[0]?.resultMessage).toContain("Clear filters");
  expect(saved.attention.find((a) => a.kind === "conversation-waiting")?.settledAt).not.toBe(null);
  await expect(screen.getByRole("region", "Block activations")).toContainText(
    "Completion confirmed",
  );
  await app.screenshot("worker-answer-completed-same-visit");
});

test("a completed worker report releases review work as another direct worker", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(app.baseUrl, "UI worker · UI worker report release");
  await app.open(`/runs/${found.id}`);

  // Act — the external worker reports through Factory's public runtime boundary.
  await workerEvent(app.baseUrl, "report");

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).threadBindings.length)
    .toBe(2);
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.threadBindings.map((b) => b.role)).toEqual(["worker", "worker"]);
  expect(saved.reports[0]?.completionEligibleAt).not.toBe(null);
  expect(saved.reports[0]?.exitId).toBe("review");
  expect(saved.activations.map((a) => a.blockId)).toEqual(["worker", "reviewer"]);
  await expect(screen.getByRole("region", "Block activations")).toContainText(
    "Delivered → Review implementation",
  );
  await expect(screen.getByRole("link", "Open Run conversation", { exact: true })).toBeVisible();
  await app.screenshot("worker-report-released-to-reviewer");
});

test("a Human correction revisits the same worker conversation with a distinct activation", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(app.baseUrl, "UI worker · Waiting for your review");
  const before = await readHistoryRun(app.baseUrl, found.id);
  const worker = before.blocks.find((b) => b.blockId === "worker")!;
  await app.open(`/runs/${found.id}`);
  const answer = screen.getByRole("form", "Answer Your review", { exact: true });
  await answer.getByRole("combobox", "Exit").selectOption({ label: "Request changes" });
  await answer
    .getByRole("textbox", "Requested changes")
    .fill("Keep keyboard focus in the search field.");
  await app.screenshot("human-correction-ready");

  // Act
  await answer.getByRole("button", "Submit answer", { exact: true }).tap();

  // Assert
  await expect
    .poll(
      async () =>
        (await readHistoryRun(app.baseUrl, found.id)).activations.filter(
          (a) => a.blockId === "worker",
        ).length,
    )
    .toBe(2);
  await expect
    .poll(
      async () =>
        (await readHistoryRun(app.baseUrl, found.id)).blocks.find((b) => b.blockId === "worker")
          ?.executionId,
    )
    .not.toBe(worker.executionId);
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.blocks.find((b) => b.blockId === "worker")?.threadId).toBe(worker.threadId);
  expect(saved.reports).toEqual(before.reports);
  expect(saved.threadBindings.map((b) => b.role)).toEqual(["worker", "worker"]);
  expect(saved.humanOccurrences[0]?.state).toBe("answered");
  await expect(screen.getByRole("region", "Block activations")).toContainText(
    "Implement change · Visit 2",
  );
  await app.screenshot("same-worker-second-visit");
});

test("Stop closes the primary conversation and both direct worker branches durably", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(app.baseUrl, "UI worker · Parallel review from one prompt");
  const before = await readHistoryRun(app.baseUrl, found.id);
  await app.open(`/runs/${found.id}`);

  // Act
  await screen.getByRole("button", "Stop Run", { exact: true }).tap();

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).outcome)
    .toBe("stopped");
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.threadBindings).toEqual(before.threadBindings);
  expect(saved.threadBindings.map((b) => b.role)).toEqual(["worker", "worker"]);
  expect(saved.closure?.rootFrontier?.map((m) => m.threadId)).toContain(
    before.runCoordinator!.threadId,
  );
  expect(saved.closure?.rootFrontier).toHaveLength(3);
  await expect(screen.getByRole("region", "Closure evidence")).toContainText("Stopped");
  await expect(screen.getByRole("button", "Stop Run", { exact: true })).toHaveCount(0);
  await app.screenshot("root-two-workers-stopped-after-reload");
});

test("Run again starts a new worker Run from a closed Run snapshot", async ({ app, screen }) => {
  // Arrange
  const source = await findRun(app.baseUrl, "UI worker · Stopped · Earlier navigation experiment");
  await app.open(`/runs/${source.id}`);
  await screen.getByRole("button", "Run again", { exact: true }).tap();
  await screen
    .getByLabel("Initial prompt", { exact: false })
    .fill("UI direct worker second attempt");
  await expect(screen.getByText("Snapshot from source Run · configuration fixed")).toBeVisible();

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(
    screen.getByRole("heading", "UI direct worker second attempt", { exact: true }),
  ).toBeVisible();
  const created = await findRun(app.baseUrl, "UI direct worker second attempt");
  expect(created.id).not.toBe(source.id);
  await expect
    .poll(async () =>
      (await readHistoryRun(app.baseUrl, created.id)).threadBindings.map((binding) => binding.role),
    )
    .toEqual(["worker"]);
  expect((await readHistoryRun(app.baseUrl, created.id)).snapshot.executionContract).toBe(
    "run-worker-v1",
  );
  expect((await readHistoryRun(app.baseUrl, source.id)).outcome).toBe("stopped");
});

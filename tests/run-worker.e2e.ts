import { confirmSettlement } from "./support/run-history.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun, runsTitled } from "./support/run-history.ts";
import { listAgentDefinitions, readAgentDefinition } from "./support/agents.ts";
import { prepareScenarios, applyRunState } from "./support/scenarios.ts";
import { openComposerWithFlow, startLosingResponse } from "./support/composer.ts";
import {
  fillHumanReviewChanges,
  installDesktopBridge,
  shortcutMod,
} from "./support/keyboard-shortcuts.ts";

beforeEach(async ({ app }) => {
  await prepareScenarios(app.baseUrl);
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

test("Start launches a top-level Block worker and no Run conversation", async ({
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
  expect(run.runCoordinator).toBeNull();
  expect(run.number).toBeGreaterThan(0);
  expect(run.threadBindings.map((b) => b.role)).toEqual(["worker"]);
  expect(run.activations).toHaveLength(1);
  expect(run.blocks[0]?.threadId).toBe(run.threadBindings[0]?.threadId);
  await browser.reload();
  await expect(
    screen
      .getByRole("region", "Block activations")
      .getByRole("link", "Open worker in T3", { exact: true }),
  ).toHaveAttribute("href", run.threadBindings[0]!.link!);
  await app.screenshot("direct-root-worker-after-reload");
});

test("a worktree Run shows the worktree its workers share and creates no worker for a Block not yet reached", async ({
  app,
  screen,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Build and review in a worktree");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("UI worktree Run");

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("heading", "UI worktree Run", { exact: true })).toBeVisible();
  const created = await findRun(app.baseUrl, "UI worktree Run");
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, created.id)).workspace)
    .toMatchObject({ state: "bound" });
  const run = await readHistoryRun(app.baseUrl, created.id);
  assert(run.workspace.mode === "worktree");
  await expect(screen.getByRole("region", "Run workspace")).toContainText(
    `Worktree · ${run.workspace.branch} · ${run.workspace.path}`,
  );
  await app.screenshot("worktree-run-workspace");
  expect(run.threadBindings).toHaveLength(1);
  await screen.getByRole("button", "Agent Review implementation", { exact: false }).tap();
  await expect(screen.getByRole("complementary", "Block details")).toContainText(
    "Thread: unresolved",
  );
  await app.screenshot("worktree-run-unvisited-block");
});

test("an unfinished prompt reopens as a Draft after reload and Starts exactly one Run in its place", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const prompt = "UI saved draft\n  Keep the second line exactly.";
  const openRuns = screen.getByRole("navigation", "Open Runs");
  const draftRow = openRuns.getByRole("link", /^UI saved draft\s*Draft$/);
  const journeyRows = openRuns.getByRole("link", /UI (saved|newer) draft/);
  const workingRun = openRuns.getByRole("link", /Demo · Working · Improve the project picker/);
  const projectChoice = screen.getByLabel(/^Select project: /);
  await openComposerWithFlow(app, screen, "Demo · Focused change");
  await screen.getByLabel("Initial prompt", { exact: false }).fill(prompt);
  const project = await projectChoice.getAttribute("aria-label");
  await expect(draftRow).toHaveCount(0);
  await workingRun.tap();
  await expect(draftRow).toBeVisible();
  await screen.getByRole("button", "New Run (+)").tap();
  await screen.getByLabel("Initial prompt", { exact: false }).fill("UI newer draft");
  await workingRun.tap();
  await expect(journeyRows).toHaveText([/^UI newer draft/, /^UI saved draft/]);
  await browser.reload();
  await draftRow.tap();
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toHaveText(prompt);
  await expect(projectChoice).toHaveAttribute("aria-label", project!);
  await expect(screen.getByLabel("Select Flow: Demo · Focused change")).toBeVisible();
  await app.screenshot("draft-reopened-after-reload");

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("heading", "UI saved draft", { exact: true })).toBeVisible();
  const started = await runsTitled(app.baseUrl, "UI saved draft");
  expect(started).toHaveLength(1);
  expect((await readHistoryRun(app.baseUrl, started[0]!.id)).input).toBe(prompt);
  await expect(draftRow).toHaveCount(0);
  await expect(journeyRows).toHaveText([/^UI newer draft\s*Draft$/, /UI saved draft/]);
  await app.screenshot("draft-started-once");
});

test("a reopened Draft continues typing at the end of its prompt", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const openRuns = screen.getByRole("navigation", "Open Runs");
  const prompt = screen.getByLabel("Initial prompt", { exact: false });
  await app.open("/runs/new");
  await prompt.fill("UI caret draft");
  await openRuns.getByRole("link", /Demo · Working · Improve the project picker/).tap();
  await openRuns.getByRole("link", /^UI caret draft\s*Draft$/).tap();

  // Act
  await browser.keyboard.type(" continued");

  // Assert
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveText("UI caret draft continued");
});

test("a Draft opened by keyboard from a focused prompt with the same text continues typing at its end", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const text = "UI keyboard caret draft";
  const prompt = screen.getByLabel("Initial prompt", { exact: false });
  const listedDrafts = screen
    .getByRole("navigation", "Open Runs")
    .getByRole("link", new RegExp(`^${text}\\s*Draft$`));
  await installDesktopBridge(browser);
  await app.open("/runs/new");
  await prompt.fill(text);
  await app.open("/studio/flows");
  await app.open("/runs/new");
  await screen.getByRole("button", "New Run (+)").tap();
  await prompt.fill(text);
  await browser.keyboard.press("Home");
  await browser.keyboard.press(`${shortcutMod}+1`);
  await expect(listedDrafts).toHaveCount(2);
  await expect(prompt).toHaveText(text);

  // Act
  await browser.keyboard.type(" continued");

  // Assert
  await expect(prompt).toHaveText(`${text} continued`);
});

test("a Start whose response was lost is recovered after reload without a duplicate Run", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Focused change");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("UI recovered lost Start");
  await startLosingResponse(screen, browser);
  await browser.reload();
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toHaveText(
    "UI recovered lost Start",
  );
  await app.screenshot("lost-start-pending-after-reload");

  // Act
  await screen.getByRole("button", "Check same request", { exact: true }).tap();

  // Assert
  await expect(
    screen.getByRole("heading", "UI recovered lost Start", { exact: true }),
  ).toBeVisible();
  expect(await runsTitled(app.baseUrl, "UI recovered lost Start")).toHaveLength(1);
  await browser.reload();
  await expect(
    screen.getByRole("heading", "UI recovered lost Start", { exact: true }),
  ).toBeVisible();
  await app.screenshot("lost-start-recovered");
});

test("a worker discussing in T3 stays working without Needs input after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Discussing · Agent asked about empty-state wording",
  );
  const run = await readHistoryRun(app.baseUrl, found.id);
  await app.open(`/runs/${run.id}`);

  // Act
  await browser.reload();

  // Assert
  await expect(screen.getByRole("article", "Block Implement change")).toContainText(
    "Discussing the empty-state wording",
  );
  await expect(screen.getByRole("region", "Needs input")).toHaveCount(0);
  await expect(screen.getByRole("region", "Problem")).toHaveCount(0);
  expect((await readHistoryRun(app.baseUrl, run.id)).activations).toEqual(run.activations);
  await app.screenshot("worker-conversation-after-reload");
  await screen.getByRole("heading", "Work periods", { exact: true }).scrollIntoView();
  await expect(screen.getByText(/Report: accepted working/)).toBeVisible();
  await app.screenshot("worker-conversation-work-period");
});

test("a worker idle in working shows its message on the canvas and in its Run preview", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Monitoring · Agent is watching CI for the search fix",
  );

  // Act
  await app.open(`/runs/${found.id}`);
  await screen
    .getByRole("navigation", "Open Runs")
    .getByRole("link", /UI worker · Monitoring · Agent is watching CI/)
    .hover();

  // Assert
  await expect(screen.getByRole("article", "Block Implement change")).toContainText(
    "CI checks are still running",
  );
  await expect(browser.locator('[data-slot="tooltip-content"]')).toContainText(
    "CI checks are still running",
  );
  await expect(screen.getByRole("region", "Problem")).toHaveCount(0);
  await app.screenshot("worker-working-message");
});

test("Request report asks a worker idle in working to assess its existing work", async ({
  app,
  screen,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Monitoring · Agent is watching CI for the search fix",
  );
  await app.open(`/runs/${found.id}`);
  await screen.getByRole("button", "Agent Implement change", { exact: false }).tap();
  const details = screen.getByRole("complementary", "Block details");
  await expect(details).toContainText("Opened pull request #42");
  await expect(details.getByRole("listitem").getByText("working", { exact: true })).toBeVisible();
  await app.screenshot("worker-working-visit");

  // Act
  await details.getByRole("button", "Request report", { exact: true }).tap();

  // Assert
  await expect(details.getByText("Report requested ·", { exact: false })).toBeVisible();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.recoveries).toMatchObject([{ blockId: "worker", attentionId: null }]);
  expect(saved.attention.filter((a) => a.kind === "missing-report")).toEqual([]);
  await app.screenshot("worker-working-report-requested");
});

test("a native worker reply completes the same activation without another working report", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Discussing · Agent asked about empty-state wording",
  );
  const before = await readHistoryRun(app.baseUrl, found.id);
  await app.open(`/runs/${found.id}`);

  // Act — simulate the ordinary reply in the exact native worker conversation.
  await applyRunState(app.baseUrl, found.id, "reply turn observed");
  await applyRunState(
    app.baseUrl,
    found.id,
    "result reported",
    "Used the requested concise wording and Clear filters label.",
  );
  await applyRunState(app.baseUrl, found.id, "settled");

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).lifecycle)
    .toBe("settled");
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.activations.map((a) => a.id)).toEqual(before.activations.map((a) => a.id));
  expect(saved.threadBindings).toEqual(before.threadBindings);
  expect(saved.executions.map((e) => e.executionId)).toContain("ui-worker-reply");
  expect(saved.reports[0]?.resultMessage).toContain("Clear filters");
  await expect(screen.getByRole("region", "Block activations")).toContainText(
    "Completion confirmed",
  );
  await app.screenshot("worker-answer-completed-same-visit");
});

test("a worker's replaced report releases only its newest result to review work", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const found = await findRun(app.baseUrl, "UI worker · UI worker report release");
  await app.open(`/runs/${found.id}`);

  // Act — the external worker reports a draft, then replaces it, through Factory's public runtime boundary.
  await applyRunState(
    app.baseUrl,
    found.id,
    "result held",
    "A first draft of the project picker change.",
  );
  await applyRunState(
    app.baseUrl,
    found.id,
    "result reported",
    "The project picker change is ready for review.",
  );
  await applyRunState(app.baseUrl, found.id, "result released to a second worker");

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).threadBindings.length)
    .toBe(2);
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.threadBindings.map((b) => b.role)).toEqual(["worker", "worker"]);
  expect(saved.reports.map((r) => r.resultMessage)).toEqual([
    "A first draft of the project picker change.",
    "The project picker change is ready for review.",
  ]);
  expect(saved.reports[1]?.completionEligibleAt).not.toBe(null);
  expect(saved.activations.map((a) => a.blockId)).toEqual(["worker", "reviewer"]);
  expect(saved.activations[1]?.cause).toContain(saved.reports[1]!.id);
  await expect(screen.getByRole("region", "Block activations")).toContainText(
    "Delivered → Review implementation",
  );
  await screen.getByRole("button", "Show timeline", { exact: true }).tap();
  await expect(screen.getByRole("region", "Timeline")).toContainText(
    "result version 2 replaces the earlier result",
  );
  await expect(screen.getByRole("region", "Timeline")).toContainText(
    "Cancelled → Review implementation",
  );
  await expect(
    screen
      .getByRole("region", "Block activations")
      .getByRole("link", "Open worker in T3", { exact: true }),
  ).toHaveCount(2);
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
  const answer = await fillHumanReviewChanges(screen, "Keep keyboard focus in the search field.");
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

test("Settle confirmation cancels without changes, then stops workers and settles from the row menu", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const title = "UI worker · Working · Improve the project picker";
  const found = await findRun(app.baseUrl, title);
  await app.open(`/runs/${found.id}`);
  const row = screen.getByRole("navigation", "Open Runs").getByRole("link", new RegExp(title));
  const before = await readHistoryRun(app.baseUrl, found.id);
  await row.secondaryTap();

  // Act
  await screen.getByRole("menuitem", "Settle", { exact: true }).tap();
  const dialog = screen.getByRole("alertdialog", "Stop the work and settle this Run?");
  await expect(dialog).toContainText("Implement change · still running");
  await expect(dialog.getByRole("button", "Cancel", { exact: true })).toBeFocused();
  await browser.evaluate(
    "Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished))",
  );
  await app.screenshot("settle-confirmation");
  await dialog.getByRole("button", "Cancel", { exact: true }).tap();
  const cancelled = await readHistoryRun(app.baseUrl, found.id);
  expect(cancelled.lifecycle).toBe("active");
  expect(cancelled.settlement).toBeNull();
  expect(cancelled.gateOpen).toBe(before.gateOpen);
  expect(cancelled.events).toEqual(before.events);
  await row.secondaryTap();
  await screen.getByRole("menuitem", "Settle", { exact: true }).tap();
  await confirmSettlement(screen);

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).lifecycle)
    .toBe("settled");
  await browser.reload();
  await screen.getByRole("button", /^Settled/).tap();
  await expect(
    screen.getByRole("navigation", "Settled Runs").getByRole("link", new RegExp(title)),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(screen.getByRole("status", "Run observation")).toContainText("Settled");
  await app.screenshot("run-settled-from-row-menu");
});

test("a late report cannot revive a manually Settled Run", async ({ app, screen }) => {
  // Arrange
  const found = await findRun(app.baseUrl, "UI worker · Working · Improve the project picker");
  const response = await fetch(new URL(`/api/runs/${found.id}/settle`, app.baseUrl), {
    method: "POST",
    headers: { "X-Factory-Request": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ stopWorkers: true }),
  });
  expect(response.ok).toBe(true);
  await app.open(`/runs/${found.id}`);
  const before = await readHistoryRun(app.baseUrl, found.id);

  // Act
  const report = await applyRunState(
    app.baseUrl,
    found.id,
    "late working report",
    "Two subagents are still checking the empty state.",
  );

  // Assert
  expect(await report.json()).toMatchObject({ outcome: "RUN_SETTLED" });
  const after = await readHistoryRun(app.baseUrl, found.id);
  expect(after.lifecycle).toBe("settled");
  expect(after.reports).toEqual(before.reports);
  expect(after.activations).toEqual(before.activations);
  await expect(screen.getByRole("status", "Run observation")).toContainText("Settled");
});

test("an unresolved settlement shows worker problems and retries to Settled", async ({
  app,
  screen,
}) => {
  // Arrange
  const found = await findRun(
    app.baseUrl,
    "UI worker · Settlement unresolved · Stop support unavailable",
  );
  await app.open(`/runs/${found.id}`);
  const progress = screen.getByRole("region", "Run settlement");
  await expect(progress).toContainText("Settlement unresolved");
  await expect(progress).toContainText("not resolved");
  await expect(
    screen.getByRole("navigation", "Open Runs").getByRole("link", new RegExp(found.title)),
  ).toContainText("Settle unresolved");
  const before = await readHistoryRun(app.baseUrl, found.id);
  assert(before.settlement?.workers[0]?.problem);
  await expect(progress).toContainText(before.settlement.workers[0].problem);
  await screen.getByRole("textbox", "Search Run titles", { exact: true }).fill("no matching Run");
  await expect(
    screen.getByRole("navigation", "Open Runs").getByRole("link", new RegExp(found.title)),
  ).toHaveCount(0);
  await app.screenshot("settlement-unresolved");

  // Act
  await progress.getByRole("button", "Retry", { exact: true }).tap();

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).lifecycle)
    .toBe("settled");
  await expect(progress).toHaveCount(0);
  await app.screenshot("settlement-retry-finished");
});

test("Archive on the Run page asks for confirmation and archives both worker branches at once", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const title = "UI worker · Parallel review from one prompt";
  const found = await findRun(app.baseUrl, title);
  const before = await readHistoryRun(app.baseUrl, found.id);
  await app.open(`/runs/${found.id}`);
  await screen.getByRole("button", "Archive Run", { exact: true }).tap();
  const confirmation = screen.getByRole("dialog", `Archive “${title}”?`);
  await expect(confirmation).toContainText("cannot be restored");
  await app.screenshot("run-page-archive-confirmation");

  // Act
  await confirmation.getByRole("button", "Archive Run", { exact: true }).tap();

  // Assert
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toBeVisible();
  const saved = await readHistoryRun(app.baseUrl, found.id);
  expect(saved.lifecycle).toBe("archived");
  expect(saved.gateOpen).toBe(false);
  expect(saved.threadBindings).toEqual(before.threadBindings);
  expect(saved.blocks.map((block) => block.state)).toEqual(["stopped", "stopped"]);
  expect(await runsTitled(app.baseUrl, title)).toHaveLength(0);
  await app.open(`/runs/${found.id}`);
  await browser.reload();
  await expect(screen.getByRole("status", "Run observation")).toContainText("Archived");
  await expect(screen.getByRole("button", "Archive Run", { exact: true })).toHaveCount(0);
  await app.screenshot("archived-run-history-by-link");
});

test("the row menu opened with Shift+F10 archives a Run after confirmation", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const title = "UI worker · Two reviewers working in parallel";
  const found = await findRun(app.baseUrl, title);
  await app.open("/runs/new");
  const row = screen.getByRole("navigation", "Open Runs").getByRole("link", new RegExp(title));
  await row.press("Shift+F10");
  await screen.getByRole("menuitem", "Archive…", { exact: true }).tap();
  const confirmation = screen.getByRole("dialog", `Archive “${title}”?`);

  // Act
  await confirmation.getByRole("button", "Archive Run", { exact: true }).tap();

  // Assert
  await expect(row).toHaveCount(0);
  expect((await readHistoryRun(app.baseUrl, found.id)).lifecycle).toBe("archived");
  await browser.reload();
  await expect(screen.getByRole("navigation", "Open Runs")).not.toContainText(title);
  await app.screenshot("run-archived-from-row-menu");
});

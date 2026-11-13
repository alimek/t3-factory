import assert from "node:assert/strict";
import { beforeEach, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { prepareScenarios } from "./support/scenarios.ts";

beforeEach(async ({ app }) => {
  await prepareScenarios(app.baseUrl);
});

test("long native identities remain readable in the selected Block's Needs input after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(
    app.baseUrl,
    "UI worker · Woke · A question about keyboard shortcuts",
  );
  const run = await readHistoryRun(app.baseUrl, found.id);
  const worker = run.blocks.find((block) => block.blockId === "worker");
  assert(worker?.threadId && worker.executionId);
  expect(worker.threadId).toMatch(/^[a-f0-9-]{36}$/);
  expect(worker.executionId).toBe(`run:thread:${worker.threadId}:ordinal:1`);
  await app.open(`/runs/${run.id}`);
  await browser.reload();

  // Act
  await screen.getByRole("article", "Block Implement change", { exact: true }).tap();

  // Assert
  const input = screen.getByRole("region", "Needs input");
  await expect(input).toContainText(worker.threadId);
  await expect(input).toContainText(worker.executionId);
  await expect(input.getByRole("link", "Open in T3", { exact: true })).toHaveAttribute(
    "href",
    run.attention.find((item) => item.kind === "native-request" && !item.settledAt)!.link!,
  );
  await expect
    .poll(() =>
      browser.evaluate(
        `Array.from(document.querySelectorAll('[aria-label="Needs input"]')).every(el => el.scrollWidth <= el.clientWidth)`,
      ),
    )
    .toBe(true);
  await app.screenshot("needs-input-long-identities");
});

test("a worker whose own turn ended while its subagents still run stays working after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(app.baseUrl, "UI worker · Working · Improve the project picker");
  const run = await readHistoryRun(app.baseUrl, found.id);
  expect(run.blocks.find((block) => block.blockId === "worker")).toMatchObject({
    state: "working",
    engineStatus: "completed",
    problem: null,
  });
  await app.open(`/runs/${run.id}`);
  await browser.reload();

  // Act
  await screen.getByRole("article", "Block Implement change", { exact: true }).tap();

  // Assert
  const activations = screen.getByRole("region", "Block activations");
  await expect(activations).toContainText("Worker active");
  await expect(activations.getByRole("link", "Open worker in T3", { exact: true })).toBeVisible();
  await expect(screen.getByRole("region", "Problem")).toHaveCount(0);
  await app.screenshot("working-delegated-subagents");
});

async function openWorkingRunInspector(app: App, screen: Screen, browser: Browser) {
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(app.baseUrl, "UI worker · Working · Improve the project picker");
  await app.open(`/runs/${found.id}`);
  return screen.getByRole("complementary", "Run inspector");
}

test("Esc returns the docked inspector from a selected Block to the Run overview", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const inspector = await openWorkingRunInspector(app, screen, browser);
  await expect(inspector.getByRole("heading", "Overview", { exact: true })).toBeVisible();
  const block = screen.getByRole("button", "Agent Implement change", { exact: false });
  await block.tap();
  await expect(inspector.getByRole("heading", "Implement change", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("heading", "Overview", { exact: true })).toHaveCount(0);

  // Act
  await browser.keyboard.press("Escape");

  // Assert
  await expect(inspector.getByRole("heading", "Overview", { exact: true })).toBeVisible();
  await expect(block).toHaveAttribute("aria-pressed", "false");
});

test("the inspector breadcrumb returns from a selected Block to the Run overview", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const inspector = await openWorkingRunInspector(app, screen, browser);
  await screen.getByRole("button", "Agent Implement change", { exact: false }).tap();
  await expect(inspector.getByRole("heading", "Implement change", { exact: true })).toBeVisible();
  await app.screenshot("inspector-block-selected");

  // Act
  await inspector.getByRole("button", "Back to Run overview", { exact: true }).tap();

  // Assert
  await expect(inspector.getByRole("heading", "Overview", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("region", "Block activations")).toContainText(
    "Implement change · Visit 1",
  );
  await app.screenshot("inspector-overview");
});

test("a selected Human step is answered from the docked inspector", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(app.baseUrl, "UI worker · Waiting for your review");
  await app.open(`/runs/${found.id}`);
  await screen.getByRole("button", "Human step Your review", { exact: false }).tap();
  const inspector = screen.getByRole("complementary", "Run inspector");
  const answer = inspector.getByRole("form", "Answer Your review", { exact: true });
  await answer.getByRole("combobox", "Exit").selectOption({ label: "Request changes" });
  await answer.getByRole("textbox", "Requested changes").fill("Answered from the inspector.");

  // Act
  await answer.getByRole("button", "Submit answer", { exact: true }).tap();

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, found.id)).humanOccurrences[0]?.state)
    .toBe("answered");
  await expect(inspector.getByRole("heading", "Your review", { exact: true })).toBeVisible();
});

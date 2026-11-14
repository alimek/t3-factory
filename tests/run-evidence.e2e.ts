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

test("Key events collapses a discussing worker's repeated T3 status updates into one row", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(
    app.baseUrl,
    "UI worker · Discussing · Agent asked about empty-state wording",
  );
  const run = await readHistoryRun(app.baseUrl, found.id);
  expect(run.events.map((event) => event.kind)).toEqual([
    "started",
    "launch-acknowledged",
    "working-reported",
    ...Array(9).fill("execution-observed"),
  ]);
  await app.open(`/runs/${run.id}`);
  await browser.reload();

  // Act
  await screen.getByRole("button", "Show timeline", { exact: true }).tap();

  // Assert
  const timeline = screen.getByRole("region", "Timeline");
  await expect(screen.getByRole("tab", "Key events", { exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(timeline).toContainText("3 key events · 12 total");
  await expect(timeline.getByRole("listitem")).toHaveCount(4);
  await expect(timeline).toContainText("started");
  await expect(timeline).toContainText("entered · new T3 thread");
  await expect(timeline).toContainText("still working · not a final result");
  await expect(
    timeline.getByRole(
      "button",
      /^\d\d:\d\d(–\d\d:\d\d)? 9 T3 status updates from Implement change/,
    ),
  ).toContainText("completed ↔ running · hidden in Key events");
  await app.screenshot("timeline-key-events");
});

test("All events shows every recorded entry and stays chosen after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(
    app.baseUrl,
    "UI worker · Discussing · Agent asked about empty-state wording",
  );
  await app.open(`/runs/${found.id}`);
  await browser.reload();
  await screen.getByRole("button", "Show timeline", { exact: true }).tap();

  // Act
  await screen.getByRole("tab", "All 12", { exact: true }).tap();

  // Assert
  const timeline = screen.getByRole("region", "Timeline");
  await expect(timeline).toContainText("12 events");
  await expect(timeline.getByRole("listitem")).toHaveCount(12);
  await expect(timeline.getByText(/T3 reports · running/)).toHaveCount(4);
  await app.screenshot("timeline-all-events");
  await browser.reload();
  await expect(screen.getByRole("tab", "All 12", { exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(timeline.getByRole("listitem")).toHaveCount(12);
});

const settledRun = "UI worker · Settled · Clearer onboarding copy";
const settledResultCard = "Implement change · Visit 1 · result";

/** The completed Run's Final result in the inspector overview; the viewport is short enough to scroll the reader. */
async function openSettledResultCard(app: App, screen: Screen, browser: Browser) {
  await browser.setViewport({ width: 1440, height: 600 });
  const found = await findRun(app.baseUrl, settledRun);
  await app.open(`/runs/${found.id}`);
  const card = screen
    .getByRole("complementary", "Run inspector")
    .getByRole("article", settledResultCard, { exact: true });
  return { found, card, reader: screen.getByRole("dialog", settledResultCard, { exact: true }) };
}

async function openSettledResultReader(app: App, screen: Screen, browser: Browser) {
  const opened = await openSettledResultCard(app, screen, browser);
  await opened.card.getByRole("button", "Read result", { exact: true }).tap();
  return opened;
}

test("a completed Run's Final result renders as collapsed Markdown in the inspector and never renders its raw HTML", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(app.baseUrl, settledRun);
  const run = await readHistoryRun(app.baseUrl, found.id);
  expect(run.lifecycle).toBe("settled");
  expect(run.reports.at(-1)?.resultMessage).toContain("<img");

  // Act
  await app.open(`/runs/${found.id}`);

  // Assert
  const card = screen
    .getByRole("complementary", "Run inspector")
    .getByRole("article", settledResultCard, { exact: true });
  await expect(card.getByRole("heading", "Welcome copy updated", { exact: true })).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(4);
  await expect(card.getByRole("table")).toBeAttached();
  await expect(card.getByText('const body = t("welcome.recentProjects");')).toBeAttached();
  await expect(card.getByRole("link", "Atlas copy guide", { exact: true })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(card).toContainText('<b>Raw HTML stays text</b> <img src="missing.png"');
  expect(
    await browser.evaluate(
      `[...document.querySelectorAll('[aria-label="${settledResultCard}"]')].every(card => !card.querySelector("img, b") && card.querySelector("[data-result-preview]").scrollHeight > card.querySelector("[data-result-preview]").clientHeight) && window.resultHtmlRan === undefined`,
    ),
  ).toBe(true);
  await app.screenshot("final-result-card");
});

test("Read result opens the full rendered result with its block, exit and time in a scrolling reader", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { card, reader } = await openSettledResultCard(app, screen, browser);

  // Act
  await card.getByRole("button", "Read result", { exact: true }).tap();

  // Assert
  await expect(reader).toContainText(/Report accepted · exit Done · \d\d:\d\d/);
  await expect(reader.getByRole("heading", "Welcome copy updated", { exact: true })).toBeVisible();
  await expect(reader.getByRole("heading", "Changes", { exact: true })).toBeVisible();
  await expect(reader.getByRole("cell", "Your recent projects are in the sidebar.")).toBeVisible();
  await expect(reader.getByRole("checkbox")).toHaveCount(2);
  await expect(reader.getByRole("link", "Atlas copy guide", { exact: true })).toHaveAttribute(
    "href",
    "https://example.com/atlas/copy-guide",
  );
  await expect(reader).toContainText("<b>Raw HTML stays text</b>");
  expect(
    await browser.evaluate(
      `(() => { const body = document.querySelector('[role="dialog"] [data-result-body]'); return !body.querySelector("img, b") && body.scrollHeight > body.clientHeight; })()`,
    ),
  ).toBe(true);
  await app.screenshot("final-result-reader");
});

test("Copy Markdown places the result's unmodified raw text on the clipboard", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { found, reader } = await openSettledResultReader(app, screen, browser);
  const raw = (await readHistoryRun(app.baseUrl, found.id)).reports.at(-1)?.resultMessage;
  assert(raw);

  // Act
  await reader.getByRole("button", "Copy Markdown", { exact: true }).tap();

  // Assert
  await expect.poll(() => browser.evaluate("navigator.clipboard.readText()")).toBe(raw);
});

test("Esc closes the result reader and returns focus to the card that opened it", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { card, reader } = await openSettledResultReader(app, screen, browser);
  await expect(reader).toBeVisible();

  // Act
  await browser.keyboard.press("Escape");

  // Assert
  await expect(reader).toHaveCount(0);
  await expect(card.getByRole("button", "Read result", { exact: true })).toBeFocused();
  await expect(screen.getByRole("heading", "Overview", { exact: true })).toBeVisible();
});

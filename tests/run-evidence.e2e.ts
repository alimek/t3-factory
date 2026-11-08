import assert from "node:assert/strict";
import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { workerEvent } from "./support/worker.ts";

beforeEach(async ({ app }) => {
  await workerEvent(app.baseUrl, "prepare");
});

test("long native identities remain readable in the selected waiting Block after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(
    app.baseUrl,
    "UI worker · Needs input · Agent asked about empty-state wording",
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
    run.attention.find((item) => item.kind === "conversation-waiting" && !item.settledAt)!.link!,
  );
  await expect
    .poll(() =>
      browser.evaluate(
        `Array.from(document.querySelectorAll('[aria-label="Needs input"]')).every(el => el.scrollWidth <= el.clientWidth)`,
      ),
    )
    .toBe(true);
  await app.screenshot("waiting-long-identities");
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

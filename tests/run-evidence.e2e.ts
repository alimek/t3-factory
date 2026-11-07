import assert from "node:assert/strict";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";

test("long native identities remain readable in the selected waiting Block after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(
    app.baseUrl,
    "Demo · Needs input · Agent asked about empty-state wording",
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

test("a working Block retains distinct links to multiple native descendants after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const found = await findRun(app.baseUrl, "Demo · Working · Improve the project picker");
  const run = await readHistoryRun(app.baseUrl, found.id);
  const children = run.threadBindings.filter((binding) => binding.role === "descendant");
  expect(children).toHaveLength(2);
  expect(new Set(children.map((child) => child.threadId)).size).toBe(2);
  await app.open(`/runs/${run.id}`);
  await browser.reload();

  // Act
  await screen.getByRole("article", "Block Implement change", { exact: true }).tap();

  // Assert
  const activations = screen.getByRole("region", "Block activations");
  await expect(activations.getByRole("link", "Open descendant in T3", { exact: true })).toHaveCount(
    2,
  );
  await expect(
    activations.getByRole("link", "Open descendant in T3", { exact: true }).nth(0),
  ).toHaveAttribute("href", children[0]!.link!);
  await expect(
    activations.getByRole("link", "Open descendant in T3", { exact: true }).nth(1),
  ).toHaveAttribute("href", children[1]!.link!);
  await expect(activations).toContainText(children[0]!.threadId);
  await expect(activations).toContainText(children[1]!.threadId);
  await app.screenshot("working-multiple-descendants");
});

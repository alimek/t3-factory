import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun } from "./support/run-history.ts";

test("resizing the Flow editor refits a manually zoomed view", async ({ app, screen, browser }) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  await app.open("/studio/flows");
  await screen.getByRole("heading", "Demo · Focused change", { exact: true }).tap();
  const canvas = screen.getByRole("region", "Flow canvas");
  await screen.getByRole("button", "Fit Flow", { exact: true }).tap();
  await expect(canvas).toHaveAttribute("data-zoom", "1.000");
  await screen.getByRole("button", "Zoom in", { exact: true }).tap();
  await expect(canvas).toHaveAttribute("data-zoom", "1.100");
  await app.screenshot("flow-manual-zoom");

  // Act
  await browser.setViewport({ width: 1800, height: 1000 });

  // Assert
  await expect(canvas).toHaveAttribute("data-zoom", "1.000");
  await expect(screen.getByRole("button", "Flow input", { exact: true })).toBeVisible();
  await expect(screen.getByRole("article", "Block Implement change")).toBeVisible();
  await app.screenshot("flow-refitted-on-resize");
});

test("a fitted Run preserves manual pan and zoom through resize and status polling", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  const run = await findRun(app.baseUrl, "Demo · Working · Improve the project picker");
  await app.open(`/runs/${run.id}`);
  const canvas = screen.getByRole("region", "Execution canvas");
  await screen.getByRole("button", "Auto-arrange", { exact: true }).tap();
  await expect(screen.getByRole("button", "Auto-arrange", { exact: true })).toBeEnabled();
  await screen.getByRole("button", "Zoom in", { exact: true }).tap();
  await canvas.press("ArrowRight");
  const zoom = await canvas.getAttribute("data-zoom");
  const layer = browser.locator('[aria-label="Execution canvas"] > div[style]');
  const transform = await layer.getAttribute("style");
  await app.screenshot("run-manual-view");
  const poll = browser.waitForResponse(`**/api/runs/${run.id}`);

  // Act
  await browser.setViewport({ width: 1800, height: 1000 });
  await poll;
  await browser.waitForResponse(`**/api/runs/${run.id}`);

  // Assert
  await expect(canvas).toHaveAttribute("data-zoom", zoom!);
  await expect(layer).toHaveAttribute("style", transform!);
  await app.screenshot("run-view-preserved-after-resize-and-poll");
});

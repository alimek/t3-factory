import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { manualRunView } from "./support/canvas.ts";
import { liveReport, liveRun } from "./support/live.ts";

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

test("a fitted Run preserves manual pan and zoom through resize and live updates", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  const run = await liveRun(app, "canvas");
  await app.open(`/runs/${run}`);
  await screen.getByRole("button", "Auto-arrange", { exact: true }).tap();
  await expect(screen.getByRole("button", "Auto-arrange", { exact: true })).toBeEnabled();
  const expectViewKept = await manualRunView(screen, browser);
  await app.screenshot("run-manual-view");

  // Act
  await browser.setViewport({ width: 1800, height: 1000 });
  await liveReport(app, "canvas", "Still aligning the picker spacing.");

  // Assert
  await expect(
    screen.getByText("Still aligning the picker spacing.", { exact: true }).first(),
  ).toBeVisible();
  await expectViewKept();
  await app.screenshot("run-view-preserved-after-resize-and-live-update");
});

test("opening a working Run centers the active Block without enlarging it", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  const run = await liveRun(app, "entry-focus");

  // Act
  await app.open(`/runs/${run}`);

  // Assert
  const canvas = screen.getByRole("region", "Execution canvas");
  const active = screen.getByRole("article", "Block Implement change", { exact: true });
  await expect(active).toBeVisible();
  await expect
    .poll(async () => {
      const surface = (await canvas.boundingBox())!;
      const block = (await active.boundingBox())!;
      return Math.abs(block.x + block.width / 2 - (surface.x + surface.width / 2));
    })
    .toBeLessThan(2);
  await expect
    .poll(async () => {
      const surface = (await canvas.boundingBox())!;
      const block = (await active.boundingBox())!;
      return Math.abs(block.y + block.height / 2 - (surface.y + (surface.height + 64 - 80) / 2));
    })
    .toBeLessThan(2);
  expect(Number(await canvas.getAttribute("data-zoom"))).toBeLessThanOrEqual(1);
  await app.screenshot("working-run-entry-focus");
});

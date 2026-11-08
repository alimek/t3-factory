import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  expectFollowingReview,
  manualRunView,
  openFollowedReviewRun,
  runCanvasCenterOffset,
  runCanvasHorizontalOffset,
} from "./support/canvas.ts";
import { liveHandoff, liveReport, liveRun } from "./support/live.ts";

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
  await expect
    .poll(async () => {
      const offset = await runCanvasCenterOffset(screen, "Implement change");
      return Math.max(Math.abs(offset.x), Math.abs(offset.y));
    })
    .toBeLessThan(2);
  const canvas = screen.getByRole("region", "Execution canvas");
  expect(Number(await canvas.getAttribute("data-zoom"))).toBeLessThanOrEqual(1);
  await app.screenshot("working-run-entry-focus");
});

test("a followed Run moves the view to the newly active Block", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const canvas = await openFollowedReviewRun(app, screen, browser, "follow");

  // Act
  await liveHandoff(app, "follow");

  // Assert
  await expect
    .poll(() => runCanvasHorizontalOffset(screen, "Review implementation"))
    .toBeLessThan(2);
  await expect(canvas).toHaveAttribute("data-following", "true");
  await app.screenshot("followed-run-moves-to-reviewer");
});

test("after a pan, a newly active Block marks Follow active instead of moving the view", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const canvas = await openFollowedReviewRun(app, screen, browser, "follow-off");
  await canvas.press("ArrowRight");
  const layer = browser.locator('[aria-label="Execution canvas"] > div[style]');
  const panned = await layer.getAttribute("style");

  // Act
  await liveHandoff(app, "follow-off");

  // Assert
  await expect(
    screen.getByRole("button", "Follow active, active Blocks changed", { exact: true }),
  ).toBeVisible();
  await expect(canvas).toHaveAttribute("data-following", "false");
  await expect(layer).toHaveAttribute("style", panned!);
  await app.screenshot("follow-active-marked-after-pan");
});

test("Follow active resumes following on the newly active Block", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const canvas = await openFollowedReviewRun(app, screen, browser, "follow-resume");
  await canvas.press("ArrowRight");
  await liveHandoff(app, "follow-resume");
  const marked = screen.getByRole("button", "Follow active, active Blocks changed", {
    exact: true,
  });
  await expect(marked).toBeVisible();

  // Act
  await marked.tap();

  // Assert
  await expectFollowingReview(screen);
  await app.screenshot("follow-active-resumed");
});

test("period recenters the focused Run canvas and resumes following after a pan", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const canvas = await openFollowedReviewRun(app, screen, browser, "follow-shortcut");
  await canvas.press("ArrowRight");
  await liveHandoff(app, "follow-shortcut");
  await expect(canvas).toHaveAttribute("data-following", "false");
  await expect(
    screen.getByRole("button", "Follow active, active Blocks changed", { exact: true }),
  ).toBeVisible();

  // Act
  await canvas.press(".");

  // Assert
  expect(await runCanvasHorizontalOffset(screen, "Review implementation")).toBeLessThan(2);
  await expect(canvas).toHaveAttribute("data-following", "true");
  await expect(screen.getByRole("button", "Follow active", { exact: true })).toBeVisible();
  await app.screenshot("follow-active-shortcut-resumed");
});

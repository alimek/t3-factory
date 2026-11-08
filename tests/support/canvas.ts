import type { Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import { liveRun } from "./live.ts";

/** Zooms and pans the Run canvas by hand; the returned check proves that view is unchanged. */
export async function manualRunView(screen: Screen, browser: Browser) {
  const canvas = screen.getByRole("region", "Execution canvas");
  await screen.getByRole("button", "Zoom in", { exact: true }).tap();
  await canvas.press("ArrowRight");
  const zoom = await canvas.getAttribute("data-zoom");
  const layer = browser.locator('[aria-label="Execution canvas"] > div[style]');
  const transform = await layer.getAttribute("style");
  return async function expectKept() {
    await expect(canvas).toHaveAttribute("data-zoom", zoom!);
    await expect(layer).toHaveAttribute("style", transform!);
  };
}

/** The named Block's center minus the center of the Run canvas area between its top badges and bottom controls. */
export async function runCanvasCenterOffset(screen: Screen, blockName: string) {
  const surface = (await screen.getByRole("region", "Execution canvas").boundingBox())!;
  const box = (await screen
    .getByRole("article", `Block ${blockName}`, { exact: true })
    .boundingBox())!;
  return {
    x: box.x + box.width / 2 - (surface.x + surface.width / 2),
    y: box.y + box.height / 2 - (surface.y + (surface.height + 64 - 80) / 2),
  };
}

/**
 * Horizontal distance of the named Block from the Run canvas center. The build-and-review Blocks
 * share a row, and a status footer can change a Block's height after the view moved there.
 */
export const runCanvasHorizontalOffset = async (screen: Screen, blockName: string) =>
  Math.abs((await runCanvasCenterOffset(screen, blockName)).x);

/** Opens a live build-and-review Run once its entry view has focused the implementing Block. */
export async function openFollowedReviewRun(
  app: App,
  screen: Screen,
  browser: Browser,
  key: string,
) {
  await browser.setViewport({ width: 1600, height: 1000 });
  const run = await liveRun(app, key, "Demo · Build, review and decide");
  await app.open(`/runs/${run}`);
  await expect.poll(() => runCanvasHorizontalOffset(screen, "Implement change")).toBeLessThan(2);
  return screen.getByRole("region", "Execution canvas");
}

/** The reviewer is centered, following has resumed, and the unseen-progress marker is cleared. */
export async function expectFollowingReview(screen: Screen) {
  await expect
    .poll(() => runCanvasHorizontalOffset(screen, "Review implementation"))
    .toBeLessThan(2);
  await expect(screen.getByRole("region", "Execution canvas")).toHaveAttribute(
    "data-following",
    "true",
  );
  await expect(screen.getByRole("button", "Follow active", { exact: true })).toBeVisible();
}

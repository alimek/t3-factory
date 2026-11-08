import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

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

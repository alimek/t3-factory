import type { Browser } from "@e2e-dev/web";
import type { App, Screen } from "e2e";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./run-history.ts";

/** The seeded four-image Run includes duplicate names and an attachment without an inline reference. */
export async function openImageHistory(app: App) {
  const run = await findRun(app.baseUrl, "Demo · Parallel review from one prompt");
  const detail = await readHistoryRun(app.baseUrl, run.id);
  await app.open(`/runs/${run.id}`);
  return detail;
}

export async function expectGalleryImage(
  screen: Screen,
  browser: Browser,
  ordinal: number,
  name: string,
  sha256: string,
) {
  const dialog = screen.getByRole("dialog", `Image ${ordinal} of 4 ${name}`);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("image", `Image ${ordinal}: ${name}`)).toHaveAttribute(
    "src",
    new RegExp(`/api/run-images/${sha256}$`),
  );
  await expect
    .poll(() =>
      browser.evaluate(`() => {
        const image = document.querySelector('[role="dialog"] img');
        return !!image?.complete && image.naturalWidth > 0;
      }`),
    )
    .toBe(true);
}

export async function expectFlowInputImages(screen: Screen) {
  const input = screen.getByRole("article", "Flow input block");
  const images = input.getByRole("list", "Prompt images");
  await expect(images.getByRole("button", /^Open Image /)).toHaveCount(3);
  await expect(images.getByRole("button", "Open Image 1: screenshot.png")).toBeVisible();
  await expect(images.getByRole("button", "Open Image 2: screenshot.png")).toBeVisible();
  await expect(images.getByRole("button", "Open Image 3: focus-ring.png")).toBeVisible();
  await expect(images.getByRole("button", "Show all 4 images")).toHaveText("+1");
  await expect(input).toContainText(
    "Compare Image 1: screenshot.png with Image 2: screenshot.png with Image 3: focus-ring.png",
  );
  await expect(input).not.toContainText("Image 4: settings-mockup.png");
}

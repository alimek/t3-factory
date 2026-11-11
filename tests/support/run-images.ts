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

/** Makes every read of the Run's second image fail, as when its stored bytes are missing. */
export async function failSecondImage(
  browser: Browser,
  run: { images: readonly { sha256: string }[] },
) {
  await browser.route(
    new RegExp(`/api/run-images/${run.images[1]!.sha256}\\?v=\\d+\\.\\d+$`),
    async (route) => {
      return route.request.method === "GET" ? route.abort() : route.continue();
    },
  );
}

/** The seeded image Run with its second image's bytes failing, and how to open that image. */
export async function openWithFailedSecondImage(app: App, screen: Screen, browser: Browser) {
  const run = await openImageHistory(app);
  await failSecondImage(browser, run);
  const opener = screen
    .getByRole("article", "Flow input block")
    .getByRole("button", "Open Image 2: screenshot.png");
  return {
    run,
    openSecond: () => opener.tap(),
    dialog: screen.getByRole("dialog", "Image 2 of 4 screenshot.png"),
  };
}

/**
 * Runs `journey` while the Run images listing of project `failingProjectId` fails once and every
 * later listing, of any filter, waits unanswered. When `journey` ends, passing or failing, the gate
 * opens for good: held listings and any that arrive later fail at once, so the runner can settle.
 */
export async function withHeldRunImageListings(
  browser: Browser,
  failingProjectId: string,
  journey: () => Promise<void>,
) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let failed = false;
  await browser.route(/\/api\/run-images\?projectId=[^&]*$/, async (route) => {
    if (route.request.method !== "GET") return route.continue();
    if (!failed && route.request.url.endsWith(`projectId=${failingProjectId}`)) {
      failed = true;
      return route.abort();
    }
    await opened;
    return route.abort();
  });
  try {
    await journey();
  } finally {
    open();
  }
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
    // Image URLs carry the client's revalidation key, never the bare cacheable path.
    new RegExp(`/api/run-images/${sha256}\\?v=\\d+\\.\\d+$`),
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

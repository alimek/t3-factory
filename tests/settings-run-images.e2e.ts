import assert from "node:assert/strict";
import { beforeEach, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import type {
  EligibleRunImage,
  ProjectCatalog,
  Result,
  RunSummary,
} from "../packages/contracts/src/index.ts";
import { sha256Hex } from "../apps/backend/test/support/scenarios.ts";
import { demoImages } from "../scripts/dev/seed-support.ts";

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
});

async function read<A>(app: App, path: string) {
  const result = (await (await fetch(new URL(path, app.baseUrl))).json()) as Result<A>;
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** The seeded demo project, whose Archived and Settled Runs own the eligible demo images. */
async function projects(app: App) {
  const catalog = await read<ProjectCatalog>(app, "/api/projects");
  const runCounts = await Promise.all(
    catalog.projects.map(
      async (project) =>
        (await read<readonly RunSummary[]>(app, `/api/runs?projectId=${project.id}`)).length,
    ),
  );
  const withoutRuns = catalog.projects.find((_, index) => runCounts[index] === 0);
  assert(withoutRuns, "Expected a fixture project without Runs");
  return { demo: catalog.projects[0]!, withoutRuns };
}

const cards = (screen: Screen) =>
  screen.getByRole("list", "Run images").getByRole("button", /^Preview /);

/** Whether the selector matches an `<img>` and every match has loaded its bytes. */
const imagesLoaded = (selector: string) =>
  `() => [[...document.querySelectorAll('${selector}')]].some((images) => images.length > 0 &&
    images.every((image) => image.complete && image.naturalWidth > 0))`;

/** Whether every image URL under the selector carries a revalidation key. */
const keyedImageUrls = (selector: string) =>
  `() => [...document.querySelectorAll('${selector}')].every((image) => /\\/api\\/run-images\\/[0-9a-f]{64}\\?v=\\d+\\.\\d+$/.test(image.src))`;

/** Settings → Run images with the seeded cards listed; returns the fixture projects. */
async function openRunImages(app: App, screen: Screen) {
  const fixtureProjects = await projects(app);
  await app.open("/settings/run-images");
  await expect(cards(screen).first()).toBeVisible();
  return fixtureProjects;
}

test("Settings lists only images whose every Run is Settled or Archived", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/runs/new");

  // Act
  await app.open("/settings/run-images");

  // Assert
  await expect(screen.getByRole("heading", "Run images", { exact: true })).toBeVisible();
  await expect(screen.getByRole("group", "STORAGE").getByRole("link", "Run images")).toBeVisible();
  await expect(cards(screen).first()).toBeVisible();
  const card = screen.getByRole("button", "Preview compact-navigation.png");
  await expect(card).toContainText("Archived");
  await expect(screen.getByRole("button", "Preview welcome-copy.png")).toContainText("Settled");
  // Shared with the Active parallel-start Run, so not eligible.
  await expect(screen.getByRole("button", "Preview settings-mockup.png")).toHaveCount(0);
  await expect(screen.getByRole("button", "Preview screenshot.png")).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(`() => document.querySelector('[data-settings]')
          ?.getAnimations({ subtree: true }).length === 0 &&
        [...document.querySelectorAll('[aria-label="Run images"] img')]
          .every((image) => image.complete && image.naturalWidth > 0)`),
    )
    .toBe(true);
  expect(await browser.evaluate(keyedImageUrls('[aria-label="Run images"] img'))).toBe(true);
  await app.screenshot("settings-run-images");
});

test("a Run image card opens its preview with every Run that uses it", async ({ app, screen }) => {
  // Arrange
  await openRunImages(app, screen);

  // Act
  await screen.getByRole("button", "Preview compact-navigation.png").tap();

  // Assert
  const preview = screen.getByRole("region", "Preview of compact-navigation.png");
  await expect(preview).toContainText(/Image \d+ of \d+/);
  await expect(preview.getByRole("image", "compact-navigation.png")).toBeVisible();
  const usedBy = preview.getByRole("list", "Used by");
  await expect(usedBy).toContainText("Demo · Archived · Earlier navigation experiment");
  await expect(usedBy).toContainText("Archived · ");
  await expect(usedBy).toContainText("Image 1");
  await expect(usedBy.getByRole("link", /^Open Run /).first()).toBeVisible();
  await app.screenshot("settings-run-images-preview");
});

test("filtering Run images by the demo project names it in the summary", async ({
  app,
  screen,
}) => {
  // Arrange
  const { demo } = await openRunImages(app, screen);

  // Act
  await screen.getByRole("combobox", "Project").selectOption({ label: demo.title });

  // Assert
  await expect(screen.getByText(new RegExp(` Runs? in ${demo.title}$`))).toBeVisible();
  await expect(screen.getByRole("button", "Preview compact-navigation.png")).toBeVisible();
  await app.screenshot("settings-run-images-filtered");
});

test("a project without Settled or Archived Run images shows the empty state", async ({
  app,
  screen,
}) => {
  // Arrange
  const { withoutRuns } = await openRunImages(app, screen);

  // Act
  await screen.getByRole("combobox", "Project").selectOption({ label: withoutRuns.title });

  // Assert
  await expect(screen.getByText("No images to delete", { exact: true })).toBeVisible();
  await expect(
    screen.getByText("No stored images from Settled or Archived Runs", { exact: true }),
  ).toBeVisible();
  await expect(cards(screen)).toHaveCount(0);
  await app.screenshot("settings-run-images-empty");
});

/** Makes listing eligible Run images fail until the returned function is called. */
async function failRunImageListing(browser: Browser) {
  let failing = true;
  await browser.route(/\/api\/run-images(\?projectId=[^&]*)?$/, async (route) =>
    failing && route.request.method === "GET" ? route.abort() : route.continue(),
  );
  return () => {
    failing = false;
  };
}

const listingAlert = (screen: Screen) =>
  screen.getByRole("alert").filter({ has: screen.getByRole("button", "Retry") });

test("a failed Run images listing shows its error with Retry instead of loading forever", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/runs/new");
  await failRunImageListing(browser);

  // Act
  await app.open("/settings/run-images");

  // Assert
  await expect(listingAlert(screen)).toBeVisible();
  await expect(screen.getByText("Images not listed", { exact: true })).toBeVisible();
  await expect(screen.getByText("Listing images…", { exact: true })).toHaveCount(0);
  await expect(cards(screen)).toHaveCount(0);
  await expect(
    screen.getByText("No stored images from Settled or Archived Runs", { exact: true }),
  ).toHaveCount(0);
  await expect(screen.getByRole("button", /^Delete all /)).toHaveCount(0);
});

test("returning to a filter whose listing failed shows its new listing as pending, not the old failure", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { demo } = await openRunImages(app, screen);
  const projectFilter = screen.getByRole("combobox", "Project");
  // The demo filter's first listing fails; later listings, of any filter, wait for an answer.
  let demoFailed = false;
  const held: (() => void)[] = [];
  await browser.route(/\/api\/run-images\?projectId=[^&]*$/, async (route) => {
    if (route.request.method !== "GET") return route.continue();
    if (route.request.url.endsWith(`projectId=${demo.id}`) && !demoFailed) {
      demoFailed = true;
      return route.abort();
    }
    await new Promise<void>((release) => held.push(release));
    return route.abort();
  });
  await projectFilter.selectOption({ label: demo.title });
  await expect(listingAlert(screen)).toBeVisible();
  await projectFilter.selectOption({ label: "All projects" });
  await expect(screen.getByText("Listing images…", { exact: true })).toBeVisible();

  // Act
  await projectFilter.selectOption({ label: demo.title });

  // Assert
  await expect(screen.getByText("Listing images…", { exact: true })).toBeVisible();
  await expect(listingAlert(screen)).toHaveCount(0);
  await expect(screen.getByText("Images not listed", { exact: true })).toHaveCount(0);

  // Cleanup: the runner settles only once every held route handler has answered.
  for (const release of held) release();
});

test("Retry after a failed Run images listing lists the images", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const recover = await failRunImageListing(browser);
  await app.open("/settings/run-images");
  await expect(listingAlert(screen)).toBeVisible();
  recover();

  // Act
  await listingAlert(screen).getByRole("button", "Retry").tap();

  // Assert
  await expect(cards(screen).first()).toBeVisible();
  await expect(listingAlert(screen)).toHaveCount(0);
  await expect(screen.getByText("Images not listed", { exact: true })).toHaveCount(0);
});

/** Run images filtered to the demo project; returns the fixture projects. */
async function openDemoRunImages(app: App, screen: Screen) {
  const fixtureProjects = await openRunImages(app, screen);
  const { demo } = fixtureProjects;
  await screen.getByRole("combobox", "Project").selectOption({ label: demo.title });
  await expect(screen.getByText(new RegExp(` Runs? in ${demo.title}$`))).toBeVisible();
  return fixtureProjects;
}

const confirmation = (screen: Screen) => screen.getByRole("alertdialog", /^Delete /);

test("cancelling a filtered Delete all keeps every listed image", async ({ app, screen }) => {
  // Arrange
  const { demo } = await openDemoRunImages(app, screen);
  const listed = await cards(screen).count();
  await screen.getByRole("button", `Delete all ${listed}`).tap();
  const dialog = confirmation(screen);
  await expect(dialog).toContainText(
    new RegExp(`^Delete ${listed} images \\(.+\\) from \\d+ Runs in ${demo.title}\\?`),
  );
  await expect(dialog).toContainText("cannot be restored");
  await expect(dialog).toContainText("“Image unavailable”");
  await expect(dialog).toContainText("Images in other projects are kept.");
  await expect(dialog.getByRole("button", `Delete ${listed} images`)).toBeVisible();
  await app.screenshot("settings-run-images-confirm-all");

  // Act
  await dialog.getByRole("button", "Cancel").tap();

  // Assert
  await expect(confirmation(screen)).toHaveCount(0);
  await expect(cards(screen)).toHaveCount(listed);
  const images = await read<readonly EligibleRunImage[]>(
    app,
    `/api/run-images?projectId=${demo.id}`,
  );
  expect(images.length).toBe(listed);
});

/**
 * Whether the Run view mounted behind Settings shows its image as unavailable in both the context
 * rail and the Flow input block. The Settings dialog hides that view from the accessibility tree.
 */
const runShowsUnavailable = `() => ['[aria-label="Run context"]', '[aria-label="Flow input block"]']
  .every((selector) => document.querySelector(selector)?.textContent?.includes('Image unavailable'))`;

/** The seeded closed Run that attached the eligible image named `name`. */
async function closedRunWith(app: App, name: string) {
  const eligible = await read<readonly EligibleRunImage[]>(app, "/api/run-images");
  const run = eligible.find((image) => image.name === name)?.runs[0];
  assert(run, `Expected ${name} to be eligible`);
  return run;
}

/** Uploads seeded image bytes as another client would; identical bytes restore a deleted image. */
async function uploadAsAnotherClient(app: App, image: { data: Uint8Array }) {
  const response = await fetch(new URL(`/api/run-images/${sha256Hex(image.data)}`, app.baseUrl), {
    method: "PUT",
    headers: { "content-type": "image/png", "X-Factory-Request": "1" },
    body: new Blob([Buffer.from(image.data)]),
  });
  assert(response.ok, `Image upload failed with ${response.status}`);
}

/** Deletes stored image bytes as another client would, through the same operation Settings uses. */
async function deleteAsAnotherClient(app: App, image: { data: Uint8Array }) {
  const response = await fetch(new URL("/api/run-images/delete", app.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "X-Factory-Request": "1" },
    body: JSON.stringify({ sha256: [sha256Hex(image.data)] }),
  });
  const result = (await response.json()) as Result<{ deleted: readonly string[] }>;
  assert(result.ok && result.value.deleted.length === 1, JSON.stringify(result));
}

/** The Run with its prompt images loaded, then Settings → Run images previewing `name`. */
async function previewFromRun(
  app: App,
  screen: Screen,
  browser: Browser,
  runId: string,
  name: string,
) {
  await app.open(`/runs/${runId}`);
  const context = screen.getByRole("complementary", "Run context");
  await expect(context.getByRole("button", `Open Image 1: ${name}`)).toBeVisible();
  await expect
    .poll(() => browser.evaluate(imagesLoaded('[aria-label="Prompt images"] img')))
    .toBe(true);
  await screen.getByRole("link", /^Settings, /).tap();
  await screen.getByRole("group", "STORAGE").getByRole("link", "Run images").tap();
  await screen.getByRole("button", `Preview ${name}`).tap();
  const preview = screen.getByRole("region", `Preview of ${name}`);
  await expect(preview.getByRole("image", name)).toBeVisible();
  return preview;
}

test("an image deleted in Settings shows Image unavailable in the Run it was viewed in, without a reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const run = await closedRunWith(app, "welcome-copy.png");
  const preview = await previewFromRun(app, screen, browser, run.id, "welcome-copy.png");
  await preview.getByRole("button", "Delete image").tap();
  const dialog = confirmation(screen);
  await expect(dialog).toContainText(/^Delete welcome-copy\.png \(.+\)\?/);
  // Earlier journeys in the same run can attach the same bytes to another closed Run.
  await expect(dialog).toContainText(/Used by \d+ Runs? in /);
  await expect(dialog).toContainText(/keeps? (its|their) history and shows? “Image unavailable”/);
  await app.screenshot("settings-run-images-confirm-one");

  // Act
  await dialog.getByRole("button", "Delete image").tap();

  // Assert
  await expect(screen.getByRole("button", "Preview welcome-copy.png")).toHaveCount(0);
  await expect(screen.getByRole("button", "Preview compact-navigation.png")).toBeVisible();
  await expect.poll(() => browser.evaluate(runShowsUnavailable)).toBe(true);
  await app.screenshot("settings-run-images-after-delete");
});

test("an image whose deletion answer is lost still shows Image unavailable in the Run it was viewed in", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const run = await closedRunWith(app, "compact-navigation.png");
  const preview = await previewFromRun(app, screen, browser, run.id, "compact-navigation.png");
  // The server deletes the bytes, but its answer never reaches the client.
  await browser.route("**/api/run-images/delete", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await preview.getByRole("button", "Delete image").tap();

  // Act
  await confirmation(screen).getByRole("button", "Delete image").tap();

  // Assert
  await expect(screen.getByRole("alert")).toBeVisible();
  await expect(screen.getByRole("button", "Preview compact-navigation.png")).toHaveCount(0);
  await expect.poll(() => browser.evaluate(runShowsUnavailable)).toBe(true);
});

test("an image this client deleted shows again when its Run is revisited after another client uploads it", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await uploadAsAnotherClient(app, demoImages.welcomeCopy);
  const run = await closedRunWith(app, "welcome-copy.png");
  const preview = await previewFromRun(app, screen, browser, run.id, "welcome-copy.png");
  await preview.getByRole("button", "Delete image").tap();
  await confirmation(screen).getByRole("button", "Delete image").tap();
  await expect(screen.getByRole("button", "Preview welcome-copy.png")).toHaveCount(0);
  await screen.getByRole("button", "Close", { exact: true }).tap();
  const context = screen.getByRole("complementary", "Run context");
  await expect(context.getByText("Image unavailable", { exact: true })).toBeVisible();
  await expect(context).toContainText("Polish the first-run welcome copy");
  await app.screenshot("run-image-deleted-context");
  await screen.getByRole("navigation", "Open Runs").getByRole("link").first().tap();
  await expect(context).not.toContainText("Polish the first-run welcome copy");
  await uploadAsAnotherClient(app, demoImages.welcomeCopy);
  await browser.evaluate("() => { window.sameDocument = true; }");

  // Act
  await browser.back();

  // Assert
  await expect(context.getByRole("button", "Open Image 1: welcome-copy.png")).toBeVisible();
  await expect(context.getByText("Image unavailable", { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(imagesLoaded('[aria-label="Run context"] [aria-label="Prompt images"] img')),
    )
    .toBe(true);
  expect(
    await browser.evaluate(
      keyedImageUrls('[aria-label="Run context"] [aria-label="Prompt images"] img'),
    ),
  ).toBe(true);
  expect(await browser.evaluate("() => window.sameDocument === true")).toBe(true);
});

test("an image another client deletes shows Image unavailable when a Run viewed before is opened again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await uploadAsAnotherClient(app, demoImages.welcomeCopy);
  const run = await closedRunWith(app, "welcome-copy.png");
  await app.open(`/runs/${run.id}`);
  const context = screen.getByRole("complementary", "Run context");
  await expect(context.getByRole("button", "Open Image 1: welcome-copy.png")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(imagesLoaded('[aria-label="Run context"] [aria-label="Prompt images"] img')),
    )
    .toBe(true);
  await screen.getByRole("navigation", "Open Runs").getByRole("link").first().tap();
  await expect(context).not.toContainText("Polish the first-run welcome copy");
  await deleteAsAnotherClient(app, demoImages.welcomeCopy);
  await browser.evaluate("() => { window.sameDocument = true; }");

  // Act
  await browser.back();

  // Assert
  await expect(context).toContainText("Polish the first-run welcome copy");
  await expect(context.getByText("Image unavailable", { exact: true })).toBeVisible();
  expect(await browser.evaluate("() => window.sameDocument === true")).toBe(true);
});

test("Delete all deletes every image the project filter lists", async ({ app, screen }) => {
  // Arrange
  // Earlier journeys in the same run delete demo images; identical bytes restore them.
  await uploadAsAnotherClient(app, demoImages.compactNavigation);
  await uploadAsAnotherClient(app, demoImages.welcomeCopy);
  const { demo } = await openDemoRunImages(app, screen);
  await screen.getByRole("button", /^Delete all \d+$/).tap();

  // Act
  await confirmation(screen)
    .getByRole("button", /^Delete \d+ images?$/)
    .tap();

  // Assert
  await expect(
    screen.getByText("No stored images from Settled or Archived Runs", { exact: true }),
  ).toBeVisible();
  expect(
    await read<readonly EligibleRunImage[]>(app, `/api/run-images?projectId=${demo.id}`),
  ).toEqual([]);
});

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Locator, type Screen } from "e2e";
import { sha256Hex, solidPng } from "../apps/backend/test/support/scenarios.ts";
import { findRun, readHistoryRun, runsTitled } from "./support/run-history.ts";
import {
  expectFlowInputImages,
  expectGalleryImage,
  failSecondImage,
  openImageHistory,
  openWithFailedSecondImage,
} from "./support/run-images.ts";
import {
  dropFiles,
  openComposerWithFlow,
  pasteFiles,
  startLosingResponse,
  type CarriedFile,
} from "./support/composer.ts";

/**
 * Picked files live in ignored storage; red and blue share their original filename. Factory keeps
 * staged images for the whole run, so a journey relying on an unstaged image owns that image.
 */
const directory = ".e2e/fixtures/run-images";
const files = {
  red: { path: join(directory, "red", "screenshot.png"), data: solidPng(220, 40, 40) },
  blue: { path: join(directory, "blue", "screenshot.png"), data: solidPng(40, 70, 220) },
  green: { path: join(directory, "mockup.png"), data: solidPng(123, 45, 200) },
  amber: { path: join(directory, "diagram.png"), data: solidPng(230, 160, 20) },
  notes: { path: join(directory, "notes.txt"), data: Buffer.from("Not an image") },
};

/** A fixture file as a paste or drop carries it. */
const carried = (name: keyof typeof files): CarriedFile => ({
  name: basename(files[name].path),
  type: name === "notes" ? "text/plain" : "image/png",
  data: files[name].data,
});

/** Shared fixture state: restore attachment support even when a journey fails. */
afterEach(async ({ app }) => {
  await fixture(app, "attachments?supported=true");
});

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1100 });
  for (const file of Object.values(files)) {
    await mkdir(join(file.path, ".."), { recursive: true });
    await writeFile(file.path, file.data);
  }
});

async function fixture(app: App, path: string) {
  const response = await fetch(new URL(`/__fixture/images/${path}`, app.baseUrl), {
    method: "POST",
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return text ? (JSON.parse(text) as unknown) : undefined;
}

async function composeWithImages(
  app: App,
  screen: Screen,
  browser: Browser,
  prompt: string,
  picked: readonly (keyof typeof files)[],
) {
  await openComposerWithFlow(app, screen, "Demo · Parallel review from one prompt");
  await screen.getByLabel("Initial prompt", { exact: false }).fill(prompt);
  await browser.locator('input[type="file"]').setInputFiles(picked.map((name) => files[name].path));
}

const thumbnails = (screen: Screen) =>
  screen.getByRole("list", "Attached images").getByRole("button", /^Preview /);

const promptField = (screen: Screen) => screen.getByLabel("Initial prompt", { exact: false });

const references = (screen: Screen, name: string) =>
  promptField(screen).getByRole("button", `Preview reference ${name}`, { exact: true });

/** Opens an image's full-size preview, captures it and closes it again. */
async function checkPreview(app: App, screen: Screen, opener: Locator, frame: string) {
  await opener.tap();
  await expect(screen.getByRole("dialog", "screenshot.png")).toBeVisible();
  await app.screenshot(frame);
  await screen.getByRole("button", "Close", { exact: true }).tap();
}

async function launchedAttachments(app: App, number: number) {
  const launches = (await fixture(app, `launches?number=${number}`)) as { attachments: unknown }[];
  return launches.map((launch) => launch.attachments);
}

test("picked screenshots survive reload and every Flow-input worker receives the same originals", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await composeWithImages(app, screen, browser, "UI images review", ["red", "notes", "blue"]);
  await expect(screen.getByRole("alert").filter({ hasText: "notes.txt" })).toContainText(
    "Only PNG, JPEG, GIF and WebP images can be attached.",
  );
  await expect(thumbnails(screen)).toHaveCount(2);
  await browser.reload();
  await expect(thumbnails(screen)).toHaveCount(2);
  await checkPreview(app, screen, thumbnails(screen).first(), "images-preview-after-reload");

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("heading", "UI images review", { exact: true })).toBeVisible();
  const run = await findRun(app.baseUrl, "UI images review");
  const detail = await readHistoryRun(app.baseUrl, run.id);
  expect(detail.input).toBe(
    "UI images review\n\nAttached images: [Image 1: screenshot.png], [Image 2: screenshot.png]",
  );
  const expected = [
    { name: "image-1-screenshot.png", sha256: sha256Hex(files.red.data) },
    { name: "image-2-screenshot.png", sha256: sha256Hex(files.blue.data) },
  ];
  assert(detail.number !== null);
  expect(await launchedAttachments(app, detail.number)).toEqual([expected, expected]);
  await app.screenshot("images-run-started");
});

test("pasted and dropped screenshots become inline references and Start delivers every attached image", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Parallel review from one prompt");
  await promptField(screen).pressSequentially("UI pasted references\nCompare ");
  await pasteFiles(browser, [carried("red"), carried("notes")]);
  await expect(references(screen, "screenshot.png")).toHaveCount(1);
  await expect(screen.getByRole("alert").filter({ hasText: "notes.txt" })).toContainText(
    "Only PNG, JPEG, GIF and WebP images can be attached.",
  );
  await promptField(screen).pressSequentially("with ");
  await pasteFiles(browser, [carried("red"), carried("blue")]);
  await expect(references(screen, "screenshot.png")).toHaveCount(3);
  await expect(thumbnails(screen)).toHaveCount(2);
  await dropFiles(browser, [carried("amber")]);
  await expect(references(screen, "diagram.png")).toHaveCount(1);
  await app.screenshot("references-composed");
  await promptField(screen).press("Backspace");
  await promptField(screen).press("Backspace");
  await expect(references(screen, "diagram.png")).toHaveCount(0);
  await expect(thumbnails(screen)).toHaveCount(3);
  await browser.reload();
  await checkPreview(
    app,
    screen,
    references(screen, "screenshot.png").last(),
    "references-preview-after-reload",
  );

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("heading", "UI pasted references", { exact: true })).toBeVisible();
  const run = await findRun(app.baseUrl, "UI pasted references");
  const detail = await readHistoryRun(app.baseUrl, run.id);
  expect(detail.input).toBe(
    "UI pasted references\nCompare [Image 1: screenshot.png] with [Image 1: screenshot.png] [Image 2: screenshot.png] \n\nAttached images: [Image 1: screenshot.png], [Image 2: screenshot.png], [Image 3: diagram.png]",
  );
  const expected = [
    { name: "image-1-screenshot.png", sha256: sha256Hex(files.red.data) },
    { name: "image-2-screenshot.png", sha256: sha256Hex(files.blue.data) },
    { name: "image-3-diagram.png", sha256: sha256Hex(files.amber.data) },
  ];
  assert(detail.number !== null);
  expect(await launchedAttachments(app, detail.number)).toEqual([expected, expected]);
});

test("removing an attached thumbnail removes that image and every reference to it", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Parallel review from one prompt");
  await promptField(screen).pressSequentially("UI removed thumbnail ");
  await pasteFiles(browser, [carried("red"), carried("blue")]);
  await expect(references(screen, "screenshot.png")).toHaveCount(2);
  await pasteFiles(browser, [carried("red")]);
  await expect(references(screen, "screenshot.png")).toHaveCount(3);

  // Act
  await screen.getByRole("button", "Remove screenshot.png").first().tap();

  // Assert
  await expect(references(screen, "screenshot.png")).toHaveCount(1);
  await expect(thumbnails(screen)).toHaveCount(1);
  await browser.reload();
  await expect(references(screen, "screenshot.png")).toHaveCount(1);
  await expect(thumbnails(screen)).toHaveCount(1);
});

test("images without prompt text stay an Untitled draft with Start unavailable", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await composeWithImages(app, screen, browser, "", ["red"]);
  await expect(thumbnails(screen)).toHaveCount(1);
  const draftRow = screen
    .getByRole("navigation", "Open Runs")
    .getByRole("link", /^Untitled draft\s*Draft$/);

  // Act
  await screen.getByRole("link", /Demo · Working · Improve the project picker/).tap();

  // Assert
  await expect(draftRow).toBeVisible();
  await draftRow.tap();
  await expect(thumbnails(screen)).toHaveCount(1);
  await expect(screen.getByRole("button", "Start", { exact: true })).toBeDisabled();
  await app.screenshot("images-only-draft");
});

test("a lost image Start stays read-only and Check same request recovers exactly one Run", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await openComposerWithFlow(app, screen, "Demo · Parallel review from one prompt");
  await promptField(screen).pressSequentially("UI images lost Start ");
  await pasteFiles(browser, [carried("red"), carried("blue")]);
  await expect(references(screen, "screenshot.png")).toHaveCount(2);
  await startLosingResponse(screen, browser);
  await browser.reload();
  await expect(promptField(screen)).toHaveAttribute("aria-readonly", "true");
  await pasteFiles(browser, [carried("amber")]);
  await checkPreview(
    app,
    screen,
    references(screen, "screenshot.png").first(),
    "images-pending-reference-preview",
  );
  await expect(thumbnails(screen)).toHaveCount(2);
  await expect(references(screen, "diagram.png")).toHaveCount(0);
  await expect(screen.getByRole("button", /^Remove /)).toHaveCount(0);
  await app.screenshot("images-pending-read-only");

  // Act
  await screen.getByRole("button", "Check same request", { exact: true }).tap();

  // Assert
  await expect(screen.getByRole("heading", "UI images lost Start", { exact: true })).toBeVisible();
  expect(await runsTitled(app.baseUrl, "UI images lost Start")).toHaveLength(1);
});

test("an image Factory reports missing at Start is uploaded again and the Run starts once", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await composeWithImages(app, screen, browser, "UI images missing upload", ["green"]);
  let uploads = 0;
  await browser.route("**/api/run-images/*", async (route) => {
    const method = route.request.method;
    if (method === "HEAD") return route.fulfill({ status: 404, body: "" });
    if (method === "PUT" && uploads++ === 0)
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    return route.continue();
  });

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(
    screen.getByRole("heading", "UI images missing upload", { exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(2);
  expect(await runsTitled(app.baseUrl, "UI images missing upload")).toHaveLength(1);
});

test("a T3 without attachment support rejects the image Start and keeps the draft editable", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await composeWithImages(app, screen, browser, "UI images unsupported", ["red"]);
  await fixture(app, "attachments?supported=false");

  // Act
  await screen.getByRole("button", "Start", { exact: true }).tap();

  // Assert
  await expect(screen.getByText(/update T3 or remove the images/)).toBeVisible();
  await expect(screen.getByRole("button", "Remove screenshot.png")).toBeVisible();
  expect(await runsTitled(app.baseUrl, "UI images unsupported")).toHaveLength(0);
  await app.screenshot("images-attachments-unsupported");
});

test("Flow input overflow browses every image in manifest order, including unreferenced attachments", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const run = await openImageHistory(app);
  await expectFlowInputImages(screen);
  const input = screen.getByRole("article", "Flow input block");

  // Act: browse the complete gallery from the overflow entry.
  await input.getByRole("button", "Show all 4 images").tap();

  // Assert
  await expectGalleryImage(screen, browser, 4, "settings-mockup.png", run.images[3]!.sha256);
  await screen.getByRole("button", "Next image").tap();
  await expectGalleryImage(screen, browser, 1, "screenshot.png", run.images[0]!.sha256);
  await screen.getByRole("button", "Next image").tap();
  await expectGalleryImage(screen, browser, 2, "screenshot.png", run.images[1]!.sha256);
  await browser.keyboard.press("ArrowRight");
  await expectGalleryImage(screen, browser, 3, "focus-ring.png", run.images[2]!.sha256);
  await screen.getByRole("button", "Previous image").tap();
  await expectGalleryImage(screen, browser, 2, "screenshot.png", run.images[1]!.sha256);
  await browser.keyboard.press("ArrowLeft");
  await expectGalleryImage(screen, browser, 1, "screenshot.png", run.images[0]!.sha256);
  await app.screenshot("flow-input-image-gallery");
});

test("reloading preserves Flow input thumbnails, the image list and ordinal reference bindings", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const run = await openImageHistory(app);
  await expectFlowInputImages(screen);

  // Act
  await browser.reload();

  // Assert
  await expectFlowInputImages(screen);
  const context = screen.getByRole("complementary", "Run inspector");
  await expect(context.getByRole("list", "Prompt images").getByRole("button")).toHaveCount(4);
  await context.getByRole("button", "Image 2: screenshot.png", { exact: true }).tap();
  await expectGalleryImage(screen, browser, 2, "screenshot.png", run.images[1]!.sha256);
  await app.screenshot("flow-input-gallery-after-reload");
});

test("unavailable image bytes preserve readable prompt history and other images without Run attention", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const run = await openImageHistory(app);
  await failSecondImage(browser, run);

  // Act
  await browser.reload();

  // Assert
  const input = screen.getByRole("article", "Flow input block");
  await expectFlowInputImages(screen);
  await expect(input).toContainText("Review the Atlas settings page");
  const context = screen.getByRole("complementary", "Run inspector");
  await expect(context).toContainText("Review the Atlas settings page");
  await expect(context.getByRole("list", "Prompt images").getByRole("button")).toHaveCount(4);
  // The failed read has run before attention is checked.
  await expect(context.getByText("Image unavailable", { exact: true })).toBeVisible();
  await expect(screen.getByRole("region", "Problem")).toHaveCount(0);
  expect((await readHistoryRun(app.baseUrl, run.id)).attention).toEqual(run.attention);
});

test("the gallery shows Image unavailable with the ordinal and name for missing image bytes", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { openSecond, dialog } = await openWithFailedSecondImage(app, screen, browser);

  // Act
  await openSecond();

  // Assert
  await expect(dialog.getByText("Image unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Image 2: screenshot.png", { exact: true })).toBeVisible();
  await app.screenshot("flow-input-image-unavailable");
});

test("the gallery browses from an unavailable image to an image whose bytes are stored", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const { run, openSecond, dialog } = await openWithFailedSecondImage(app, screen, browser);
  await openSecond();
  await expect(dialog.getByText("Image unavailable", { exact: true })).toBeVisible();

  // Act
  await screen.getByRole("button", "Previous image").tap();

  // Assert
  await expectGalleryImage(screen, browser, 1, "screenshot.png", run.images[0]!.sha256);
});

test("a Flow input thumbnail opens the matching image even with a duplicate filename", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const run = await openImageHistory(app);
  const input = screen.getByRole("article", "Flow input block");

  // Act
  await input
    .getByRole("list", "Prompt images")
    .getByRole("button", "Open Image 2: screenshot.png")
    .tap();

  // Assert
  await expectGalleryImage(screen, browser, 2, "screenshot.png", run.images[1]!.sha256);
});

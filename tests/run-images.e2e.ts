import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import { sha256Hex, solidPng } from "../apps/backend/test/support/run-images.ts";
import { findRun, readHistoryRun, runsTitled } from "./support/run-history.ts";
import { openComposerWithFlow, startLosingResponse } from "./support/composer.ts";

/** Picked files live in ignored storage; red and blue share their original filename. */
const directory = ".e2e/fixtures/run-images";
const files = {
  red: { path: join(directory, "red", "screenshot.png"), data: solidPng(220, 40, 40) },
  blue: { path: join(directory, "blue", "screenshot.png"), data: solidPng(40, 70, 220) },
  green: { path: join(directory, "mockup.png"), data: solidPng(123, 45, 200) },
  notes: { path: join(directory, "notes.txt"), data: Buffer.from("Not an image") },
};

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
  await thumbnails(screen).first().tap();
  await expect(screen.getByRole("dialog", "screenshot.png")).toBeVisible();
  await app.screenshot("images-preview-after-reload");
  await screen.getByRole("button", "Close", { exact: true }).tap();

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
  const launches = (await fixture(app, `launches?number=${detail.number}`)) as {
    attachments: unknown;
  }[];
  expect(launches.map((launch) => launch.attachments)).toEqual([expected, expected]);
  await app.screenshot("images-run-started");
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
  await composeWithImages(app, screen, browser, "UI images lost Start", ["red", "blue"]);
  await startLosingResponse(screen, browser);
  await browser.reload();
  await expect(thumbnails(screen)).toHaveCount(2);
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
  await fixture(app, "attachments?supported=true");
});

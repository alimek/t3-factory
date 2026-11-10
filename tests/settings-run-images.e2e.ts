import assert from "node:assert/strict";
import { beforeEach, test } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import type { ProjectCatalog, Result, RunSummary } from "../packages/contracts/src/index.ts";

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

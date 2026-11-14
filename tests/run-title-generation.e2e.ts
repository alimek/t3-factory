import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  Result,
  RunTitleSetting,
  UpdateRunTitleSettingInput,
} from "../packages/contracts/src/index.ts";
import { openComposerWithFlow } from "./support/composer.ts";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";
import { applyRunState } from "./support/scenarios.ts";

const titleModel = {
  providerInstanceId: "codex-main",
  modelId: "gpt-6.1-sol",
  modelOptions: [{ id: "reasoning", value: "low" }],
};

async function runTitleSetting(baseUrl: string | undefined, input?: UpdateRunTitleSettingInput) {
  const response = await fetch(new URL("/api/settings/run-titles", baseUrl), {
    method: input ? "PUT" : "GET",
    headers: { "X-Factory-Request": "1", "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const result = (await response.json()) as Result<RunTitleSetting>;
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1000 });
});

// Journeys share one Factory: later Runs keep their automatic titles.
afterEach(async ({ app }) => {
  const { model } = await runTitleSetting(app.baseUrl);
  await runTitleSetting(app.baseUrl, { enabled: false, model });
});

test("the host turns on Generate Run titles with a provider instance and model from T3", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/settings/run-titles");
  const section = screen.getByRole("region", "Generate Run titles");
  await expect(screen.getByText(/^The title model runs in the Project checkout/)).toBeVisible();
  await section.getByRole("button", /^Provider instance: /).tap();
  await screen.getByRole("menuitemradio", "Codex", { exact: true }).tap();
  await section.getByRole("button", /^Model: /).tap();
  await screen.getByRole("menuitemradio", "GPT 6 Astra", { exact: true }).tap();
  await expect(section.getByRole("button", "Model: GPT 6 Astra")).toBeEnabled();

  // Act
  await section.getByRole("checkbox", "Generate Run titles").tap();

  // Assert
  await expect(section.getByRole("checkbox", "Generate Run titles")).toBeChecked();
  await expect(section).toContainText("On · Codex · GPT 6 Astra");
  expect(await runTitleSetting(app.baseUrl)).toMatchObject({
    enabled: true,
    model: { providerInstanceId: "codex-main", modelId: "gpt-6-astra" },
  });
  await browser.reload();
  await expect(
    screen.getByRole("region", "Generate Run titles").getByRole("checkbox", "Generate Run titles"),
  ).toBeChecked();
  await app.screenshot("run-titles-host-on");
});

test("a Run started while Generate Run titles is on shows Generating title… until its generated title replaces the automatic title", async ({
  app,
  screen,
}) => {
  // Arrange
  const automaticTitle = "UI title journey · Rank exact project-name matches first";
  const generatedTitle = "UI generated · Exact matches first";
  await runTitleSetting(app.baseUrl, { enabled: true, model: titleModel });
  await openComposerWithFlow(app, screen, "Demo · Focused change");
  await screen
    .getByLabel("Initial prompt", { exact: false })
    .fill(`${automaticTitle}\nKeep the current order for every other result.`);
  await screen.getByRole("button", "Start", { exact: true }).tap();
  await expect(screen.getByRole("heading", automaticTitle, { exact: true })).toBeVisible();
  const runRow = screen.getByRole("navigation", "Open Runs").getByRole("link", /UI title journey/);
  await expect(runRow.getByText("Generating title…")).toBeVisible();
  await expect(screen.getByText("Generating title…")).toHaveCount(2);
  await app.screenshot("run-title-generating");
  const run = await findRun(app.baseUrl, automaticTitle);

  // Act: the title thread submits its title through factory_set_run_title.
  await applyRunState(app.baseUrl, run.id, "generated title applied", generatedTitle);

  // Assert
  await expect(screen.getByRole("heading", generatedTitle, { exact: true })).toBeVisible();
  await expect(screen.getByText("Generating title…")).toHaveCount(0);
  await expect(
    screen.getByRole("navigation", "Open Runs").getByRole("link", /UI generated · Exact matches/),
  ).toBeVisible();
  await expect(screen.getByRole("button", /^Run title, applied/)).toContainText(
    `Title · applied · ${generatedTitle}`,
  );
  expect((await readHistoryRun(app.baseUrl, run.id)).titleGeneration).toMatchObject({
    state: "applied",
    automaticTitle,
    generatedTitle,
  });
  await app.screenshot("run-title-applied");
});

test("pressing a Run's title line opens its title details with the title thread link and leaves Follow active as it was", async ({
  app,
  screen,
}) => {
  // Arrange
  const seeded = await findRun(
    app.baseUrl,
    "Demo · Generated title · Exact matches first in search",
  );
  const { titleGeneration } = await readHistoryRun(app.baseUrl, seeded.id);
  assert(titleGeneration?.threadLink);
  await app.open(`/runs/${seeded.id}`);
  const canvas = screen.getByRole("region", "Execution canvas");
  await expect(canvas).toHaveAttribute("data-following", "true");

  // Act
  await screen.getByRole("button", /^Run title, applied/).tap();

  // Assert
  const details = screen.getByRole("complementary", "Run title details");
  await expect(details.getByRole("link", "Open title thread in T3")).toHaveAttribute(
    "href",
    titleGeneration.threadLink,
  );
  await expect(screen.getByRole("button", /^Run title, applied/)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(canvas).toHaveAttribute("data-following", "true");
  await app.screenshot("run-title-details");
});

test("an approved client sees Generate Run titles and its latest diagnostic read-only, managed on the Factory host", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "compatible");
  await remoteFixture(app, "run-titles/diagnostic");
  await app.open("/__fixture/remote-browser");

  // Act
  await openApproved(app, "/settings/run-titles");

  // Assert
  await expect(screen.getByText("Managed on the Factory host")).toBeVisible();
  const section = screen.getByRole("region", "Generate Run titles");
  await expect(section.getByRole("checkbox", "Generate Run titles")).toBeChecked();
  await expect(section.getByRole("checkbox", "Generate Run titles")).toBeDisabled();
  await expect(section.getByRole("button", /^Provider instance: /)).toBeDisabled();
  await expect(section.getByRole("button", /^Model: /)).toBeDisabled();
  await expect(screen.getByText(/^Latest title generation skipped · Run #\d+/)).toBeVisible();
  await expect(screen.getByText(/T3 does not offer gpt-6\.1-luna for Codex\./)).toBeVisible();
  await app.screenshot("run-titles-approved-client");
});

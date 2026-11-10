import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createStudioFlow, expectFlowBlocked } from "./support/flows.ts";
import { findRun } from "./support/run-history.ts";
import { applyRunState, scenarioFixture } from "./support/scenarios.ts";

/** A Flow in Studio whose Sample worker hands its result to a Wait named Cool down. */
async function workerThenWait(
  app: Parameters<typeof createStudioFlow>[0],
  screen: Parameters<typeof createStudioFlow>[1],
  browser: Parameters<typeof createStudioFlow>[2],
  name: string,
) {
  await createStudioFlow(app, screen, browser, name);
  await screen.getByRole("button", "Add Sample worker").tap();
  await screen.getByLabel("Block name").fill("Build");
  await screen.getByLabel("X position").fill("320");
  await screen.getByLabel("Y position").fill("60");
  await screen.getByRole("button", "Add Wait").tap();
  await screen.getByLabel("Block name").fill("Cool down");
  await screen.getByLabel("X position").fill("680");
  await screen.getByLabel("Y position").fill("60");
  await screen
    .getByRole("button", "Connect exit finish of Build")
    .dragTo(screen.getByRole("article", "Block Cool down"));
}

test("a Wait saved without a duration keeps the draft and names the readiness gap", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await workerThenWait(app, screen, browser, "Pause before review");

  // Act
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expectFlowBlocked(screen, /Enter how long Cool down waits/);
  await expect(screen.getByRole("article", "Block Cool down")).toContainText("duration not set");
  await app.screenshot("wait-readiness-gap");
});

test("a saved draft whose Flow input reaches a Wait renders the wire and cannot start", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });

  // Act
  await app.open("/studio/flows");
  await screen.getByRole("link", /Staged rollout \(needs repair\)/).tap();

  // Assert
  await expectFlowBlocked(screen, /Cool down cannot receive the Flow input/);
  await expect(screen.getByRole("article", "Block Observe the rollout")).toContainText(
    "duration not set",
  );
  await app.screenshot("wait-flow-input-gap");
});

test("a Wait's name, duration and unit survive Save and reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await workerThenWait(app, screen, browser, "Pause then release");
  await screen.getByRole("button", "Wait Cool down", { exact: false }).tap();
  await screen.getByRole("spinbutton", "Duration required").fill("2");
  await screen.getByRole("combobox", "Duration unit").selectOption("hours");

  // Act
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expect(screen.getByRole("article", "Block Cool down")).toContainText("waits 2 hours");
  await expect(screen.getByRole("region", "Output · one")).toContainText("Message forwarded");
  await app.screenshot("wait-authoring");
  await browser.reload();
  await screen.getByRole("button", "Wait Cool down", { exact: false }).tap();
  await expect(screen.getByLabel("Block name")).toHaveValue("Cool down");
  await expect(screen.getByRole("spinbutton", "Duration required")).toHaveValue("2");
  await expect(screen.getByRole("combobox", "Duration unit")).toHaveValue("hours");
});

test(
  "a released result waits at a one-minute Wait with its message and is forwarded when it elapses",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    // Arrange
    await browser.setViewport({ width: 1440, height: 1100 });
    const response = await scenarioFixture(app.baseUrl, "ensure", {
      key: "wait-minute",
      flow: "Journey · One-minute wait",
    });
    const { id } = (await response.json()) as { id: string };
    await applyRunState(app.baseUrl, id, "result reported", "Release notes drafted.");

    // Act
    await app.open(`/runs/${id}`);

    // Assert
    const pause = screen.getByRole("article", "Block Pause");
    await expect(pause).toContainText("waiting", { timeout: 15_000 });
    await expect(pause).toContainText("until");
    await pause.getByRole("button", "Wait Pause", { exact: false }).tap();
    const details = screen.getByRole("complementary", "Block details");
    await expect(details.getByRole("listitem", "Arrival 1")).toContainText(
      "Release notes drafted.",
    );
    await app.screenshot("wait-pending");
    await expect(pause).toContainText("finished", { timeout: 120_000 });
    await expect(details.getByRole("listitem", "Arrival 1")).toContainText("elapsed → forwarded");
    await expect(details.getByRole("listitem", "Arrival 1")).toContainText("Message cleared");
    await app.screenshot("wait-forwarded");
  },
);

test("two reviews waiting at one Wait show the nearest deadline and how many wait", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const run = await findRun(app.baseUrl, "Demo · Wait · Both reviews soaking before release");

  // Act
  await app.open(`/runs/${run.id}`);

  // Assert
  const soak = screen.getByRole("article", "Block Soak before release");
  await expect(soak).toContainText("2 pending");
  await expect(soak).not.toContainText("Needs input");
  await soak.getByRole("button", "Wait Soak before release", { exact: false }).tap();
  const details = screen.getByRole("complementary", "Block details");
  await expect(details.getByRole("listitem", "Arrival 1")).toContainText("waiting until");
  await expect(details.getByRole("listitem", "Arrival 2")).toContainText("waiting until");
  await app.screenshot("wait-two-pending");
});

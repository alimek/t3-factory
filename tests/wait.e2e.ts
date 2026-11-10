import { openPendingReviewWait } from "./support/waits.ts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createStudioFlow, expectFlowBlocked } from "./support/flows.ts";
import { findRun, readHistoryRun } from "./support/run-history.ts";
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

test("a Human approval waits with its reviewer, and parallel approvals keep separate deadlines", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/studio/flows");
  await screen.getByRole("link", /Demo · Review, soak and release/).tap();
  await screen.getByRole("button", "Save Flow", { exact: true }).tap();
  await browser.reload();
  await expect(screen.getByRole("article", "Block Approve release")).toBeVisible();
  await expect(screen.getByRole("article", "Block Soak before release")).toContainText(
    "waits 2 hours",
  );
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeEnabled();
  await app.screenshot("human-wait-saved-flow");
  const pending = await findRun(app.baseUrl, "Demo · Wait · Approve reviews before soaking");
  const before = await readHistoryRun(app.baseUrl, pending.id);
  await app.open(`/runs/${pending.id}`);
  const answer = screen.getByRole("form", "Answer Approve release", { exact: true });
  await answer.getByRole("combobox", "Exit").selectOption({ label: "Approve" });
  await answer.getByRole("textbox", "Response").fill("Approved for the release soak.");
  await app.screenshot("human-before-wait");

  // Act
  await answer.getByRole("button", "Submit answer", { exact: true }).tap();

  // Assert
  await expect
    .poll(async () => (await readHistoryRun(app.baseUrl, pending.id)).waitArrivals.length)
    .toBe(1);
  await browser.reload();
  const saved = await readHistoryRun(app.baseUrl, pending.id);
  expect(saved.humanOccurrences[0]?.state).toBe("answered");
  expect(saved.waitArrivals[0]?.message).toBe("Approved for the release soak.");
  expect(saved.waitArrivals[0]?.origin?.activationId).toBe(
    before.reports.find((report) => report.blockId === "reviewer")?.activationId,
  );
  const waiting = screen.getByRole("article", "Block Soak before release");
  await expect(waiting).toContainText("waiting");
  await waiting.getByRole("button", "Wait Soak before release", { exact: false }).tap();
  await expect(screen.getByRole("complementary", "Block details")).toContainText(
    "Approved for the release soak.",
  );
  await app.screenshot("human-answer-waiting");
  const run = await findRun(app.baseUrl, "Demo · Wait · Both reviews soaking before release");
  await app.open(`/runs/${run.id}`);
  await openPendingReviewWait(screen);
  await app.screenshot("wait-two-pending");
});

test("Continue now advances a selected review while the other keeps waiting", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  const run = await findRun(app.baseUrl, "Demo · Wait · Both reviews soaking before release");

  const approved = await readHistoryRun(app.baseUrl, run.id);
  expect(approved.humanOccurrences).toHaveLength(2);
  expect(approved.humanOccurrences[0]?.state).toBe("answered");
  expect(approved.humanOccurrences[1]?.state).toBe("answered");
  expect(approved.waitArrivals[0]?.sourceBlockId).toBe(approved.humanOccurrences[0]?.blockId);
  expect(approved.waitArrivals[1]?.sourceBlockId).toBe(approved.humanOccurrences[1]?.blockId);

  await app.open(`/runs/${run.id}`);

  const { soak, details } = await openPendingReviewWait(screen);
  await expect(soak.getByRole("button", "Continue now")).toHaveCount(0);
  await app.screenshot("wait-two-pending");
  // Act
  await details.getByRole("listitem", "Arrival 1").getByRole("button", "Continue now").tap();

  // Assert
  await expect(details.getByRole("listitem", "Arrival 1")).toContainText("forwarded early by user");
  await expect(
    details.getByRole("listitem", "Arrival 1").getByRole("button", "Continue now"),
  ).toHaveCount(0);
  await expect(details.getByRole("listitem", "Arrival 2")).toContainText("waiting until");
  await expect(soak).not.toContainText("2 pending");
  await expect(soak.getByRole("button", "Continue now")).toBeVisible();
  await screen.getByRole("button", "Show timeline", { exact: true }).tap();
  await expect(screen.getByRole("region", "Timeline")).toContainText("forwarded early by user");
  await screen
    .getByRole("region", "Timeline")
    .getByText("forwarded early by user", { exact: false })
    .scrollIntoView();
  await app.screenshot("wait-selected-continued");
  await soak.getByRole("button", "Continue now").tap();
  await expect(soak).toContainText("finished");
  await expect(details.getByRole("listitem", "Arrival 2")).toContainText("forwarded early by user");
  await expect(soak.getByRole("button", "Continue now")).toHaveCount(0);
  await app.screenshot("wait-all-continued");
  await browser.reload();
  await soak.getByRole("button", "Wait Soak before release", { exact: false }).tap();
  await expect(details.getByRole("listitem", "Arrival 1")).toContainText("forwarded early by user");
});

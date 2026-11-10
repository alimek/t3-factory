import assert from "node:assert/strict";
import type { FlowDraft, Result } from "../packages/contracts/src/index.ts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { applyRunState, prepareScenarios, scenarioFixture } from "./support/scenarios.ts";

test("a Wait added from the library saves with a missing duration as a readiness gap, then reloads ready with its duration and output", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  await app.open("/studio/flows");
  await screen.getByRole("button", "New Flow").tap();
  await screen.getByLabel("Flow name").fill("Wait before review");
  await screen.getByRole("button", "Create Flow").tap();
  await screen.getByRole("button", "Add Sample worker").tap();
  await screen.getByLabel("Block name").fill("Coder");
  await screen.getByLabel("X position").fill("320");
  await screen.getByLabel("Y position").fill("60");
  await screen.getByRole("button", "Add Wait").tap();
  await screen.getByLabel("Block name").fill("Cool down");
  await screen.getByLabel("X position").fill("680");
  await screen.getByLabel("Y position").fill("60");
  const wait = screen.getByRole("article", "Block Cool down");
  await screen.getByRole("button", "Agent Coder").tap();
  await screen.getByRole("button", "Connect exit finish of Coder").dragTo(wait);
  await screen
    .getByRole("button", "Connect Flow input")
    .dragTo(screen.getByRole("article", "Block Coder"));
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 2");
  await expect(screen.getByRole("button", /Not execution-ready · 1 issue/)).toBeVisible();
  await expect(screen.getByText("Enter how long Cool down waits.", { exact: false })).toBeVisible();
  await app.screenshot("wait-readiness-missing-duration");

  // Act
  await screen.getByRole("button", "Wait Cool down").tap();
  await screen.getByLabel("Wait for").fill("90");
  await screen.getByLabel("Unit").selectOption("minutes");
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 3");
  await expect(screen.getByText("Graph ready")).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole("article", "Block Cool down")).toContainText("90 minutes");
  await screen.getByRole("button", "Wait Cool down").tap();
  await expect(screen.getByLabel("Wait for")).toHaveValue("90");
  await expect(screen.getByRole("region", "Output")).toContainText("finish here");
  await app.screenshot("wait-configured-after-reload");
  const path = new URL(await browser.url()).pathname;
  const saved = (await (
    await fetch(new URL(`/api${path.replace(/^\/studio/, "")}`, app.baseUrl))
  ).json()) as Result<FlowDraft>;
  assert(saved.ok);
  expect(saved.value.graph.blocks[1]).toMatchObject({
    kind: "wait",
    name: "Cool down",
    duration: { amount: 90, unit: "minutes" },
  });
});

test("Run canvases show several waiting arrivals with their nearest deadline, and one arrival forwarded once its minute elapses", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  await prepareScenarios(app.baseUrl);
  const held = await findRun(
    app.baseUrl,
    "UI worker · Waiting · Two reviews held for the morning sync",
  );
  await app.open(`/runs/${held.id}`);
  await expect(screen.getByRole("article", "Block Hold for the morning sync")).toContainText(
    "2 waiting · next until",
  );
  await app.screenshot("wait-two-arrivals");
  const started = await scenarioFixture(app.baseUrl, "ensure", {
    key: "wait",
    flow: "UI wait · Pause a minute",
  });
  const { id: runId } = (await started.json()) as { id: string };
  await applyRunState(app.baseUrl, runId, "result reported", "Ready after a short pause.");
  await applyRunState(app.baseUrl, runId, "result released to a Wait");
  await app.open(`/runs/${runId}`);
  await screen.getByRole("button", /^Wait Pause a minute, waiting/).tap();
  await expect(screen.getByRole("listitem", "Arrival 1, waiting")).toContainText(
    "Ready after a short pause.",
  );
  await app.screenshot("wait-one-arrival-pending");

  // Act
  const forwarded = screen.getByRole("button", /^Wait Pause a minute, finished/);
  await expect(forwarded).toBeVisible({ timeout: 90_000 });

  // Assert
  await expect(screen.getByRole("listitem", "Arrival 1, forwarded")).toContainText(
    "elapsed, forwarded",
  );
  await browser.reload();
  await expect(screen.getByRole("button", /^Wait Pause a minute, finished/)).toBeVisible();
  const run = await readHistoryRun(app.baseUrl, runId);
  expect(run.waitArrivals.map((arrival) => [arrival.state, arrival.forwardedBy])).toEqual([
    ["forwarded", "timer"],
  ]);
  expect(run.events.filter((event) => event.kind.startsWith("wait-")).map((e) => e.kind)).toEqual([
    "wait-started",
    "wait-forwarded",
  ]);
  await app.screenshot("wait-one-arrival-forwarded");
});

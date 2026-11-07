import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { findRun, readHistoryRun } from "./support/run-history.ts";
import { workerEvent } from "./support/worker.ts";

test("a rejected report explains the missing accepted result and recovery assesses existing work", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await workerEvent(app.baseUrl, "prepare");
  const run = await findRun(app.baseUrl, "UI worker · Problem · Report exit needs correction");
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open(`/runs/${run.id}`);
  await screen.getByRole("button", "Implement change", { exact: false }).tap();
  await expect(screen.getByText("INVALID_EXIT:", { exact: false })).toBeVisible();
  await expect(screen.getByText("No report was accepted", { exact: false })).toBeVisible();
  await app.screenshot("rejected-report-explained");

  // Act
  await screen.getByRole("button", "Request report", { exact: true }).tap();

  // Assert
  await expect(screen.getByText("Report requested ·", { exact: false })).toBeVisible();
  await browser.reload();
  await screen.getByRole("button", "Implement change", { exact: false }).tap();
  await expect(screen.getByText("INVALID_EXIT:", { exact: false })).toBeVisible();
  await expect(screen.getByText("Report requested ·", { exact: false })).toBeVisible();
  const saved = await readHistoryRun(app.baseUrl, run.id);
  expect(saved.recoveries).toHaveLength(1);
  expect(saved.reports).toEqual([]);
  await app.screenshot("rejected-report-assessment-requested");
});

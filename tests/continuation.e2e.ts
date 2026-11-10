import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createStudioFlow } from "./support/flows.ts";
import { findRun } from "./support/run-history.ts";

test("a Continuation added after an Agent names the thread it continues and keeps its prompt after Save and reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await createStudioFlow(app, screen, browser, "Grill then spec");
  await screen.getByRole("button", "Add Sample worker").tap();
  await screen.getByLabel("Block name").fill("Grill");
  await screen.getByLabel("X position").fill("320");
  await screen.getByLabel("Y position").fill("60");
  await screen.getByRole("button", "Add Continuation").tap();
  await screen.getByLabel("Block name").fill("Spec");
  await screen.getByLabel("X position").fill("680");
  await screen.getByLabel("Y position").fill("60");
  await screen.getByRole("textbox", "Prompt required").fill("Write the spec from what we agreed.");
  await screen
    .getByRole("button", "Connect exit finish of Grill")
    .dragTo(screen.getByRole("article", "Block Spec"));

  // Act
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expect(screen.getByRole("article", "Block Spec")).toContainText("Grill's thread");
  await expect(screen.getByRole("region", "Conversation")).toContainText(
    "Continues Grill's thread",
  );
  await app.screenshot("continuation-authoring");
  await browser.reload();
  await screen.getByRole("button", "Continuation Spec", { exact: false }).tap();
  await expect(screen.getByRole("textbox", "Prompt required")).toHaveValue(
    "Write the spec from what we agreed.",
  );
});

test("a Continuation whose response went on passes through while the next Continuation's prompt is sent to the same thread", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1100 });
  // The development seed's Run; the scenario copy belongs to the worker journeys.
  const run = await findRun(app.baseUrl, "Demo · Continuation · Spec passed on to Tickets");

  // Act
  await app.open(`/runs/${run.id}`);

  // Assert
  const spec = screen.getByRole("article", "Block Spec");
  const tickets = screen.getByRole("article", "Block Tickets");
  await expect(spec).toContainText("pass-through");
  await expect(spec).toContainText("Grill the change's thread");
  await expect(tickets).toContainText("sent");
  await expect(tickets).toContainText("Grill the change's thread");
  await screen.getByRole("button", "Fit Flow").tap();
  await spec.getByRole("button", "Continuation Spec", { exact: false }).tap();
  await app.screenshot("continuation-run");
});

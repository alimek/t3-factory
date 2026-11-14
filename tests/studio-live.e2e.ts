import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import assert from "node:assert/strict";
import { copyAgentDefinition, removeAgentElsewhere, updateAgentExits } from "./support/agents.ts";
import { createFlowElsewhere, removeFlowElsewhere, renameFlow } from "./support/flows.ts";

test("an Agent created by another client appears in the open Agents list and sidebar count", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/studio/agents");
  await expect(screen.getByRole("link", "Sample worker", { exact: true })).toBeVisible();
  const counted = await screen.getByRole("link", "Agents", { exact: true }).textContent();

  // Act
  await copyAgentDefinition(app.baseUrl, "Sample worker", "Live Studio Agent");

  // Assert
  await expect(screen.getByRole("link", "Live Studio Agent", { exact: true })).toBeVisible();
  await expect(screen.getByRole("link", "Agents", { exact: true })).not.toHaveText(counted ?? "");
});

test("an open Agent editor with unsaved edits compares a revision saved elsewhere and keeps the edits", async ({
  app,
  screen,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Compared Studio Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await screen.getByLabel("Name").fill("Compared Studio Agent, my edits");
  await updateAgentExits(app.baseUrl, agent, [
    ...agent.exits,
    { id: "escalate", name: "escalate", description: "", messageRequired: false },
  ]);
  await expect(screen.getByText("Revision 2 was saved elsewhere.", { exact: false })).toBeVisible();

  // Act
  await screen.getByRole("button", "Compare latest revision").tap();
  await screen.getByRole("button", "Keep my edits against revision 2").tap();

  // Assert
  await expect(screen.getByLabel("Name")).toHaveValue("Compared Studio Agent, my edits");
  await expect(screen.getByText("Agent definition · rev 2")).toBeVisible();
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeEnabled();
});

test("an Agent removed elsewhere keeps its editable draft, copies it as JSON and asks before discarding it", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Removed Studio Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await screen.getByLabel("Name").fill("Removed Studio Agent draft");
  await removeAgentElsewhere(app.baseUrl, agent.id);
  await expect(screen.getByText("This Agent was removed elsewhere.")).toBeVisible();

  // Act
  await screen.getByRole("button", "Copy as JSON").tap();

  // Assert
  await expect(screen.getByText("Copied to the clipboard.")).toBeVisible();
  const copied = JSON.parse(await browser.evaluate("navigator.clipboard.readText()"));
  assert.deepStrictEqual(copied, {
    name: "Removed Studio Agent draft",
    prompt: agent.prompt,
    execution: agent.execution,
    exits: agent.exits,
  });
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("button", "Duplicate")).toBeDisabled();
  await expect(screen.getByRole("link", "Removed Studio Agent", { exact: true })).toHaveCount(0);
  await screen.getByRole("link", "Sample worker", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "This Agent was removed elsewhere. Discard the retained draft?"),
  ).toBeVisible();
});

test("an open Flow editor without unsaved changes takes a revision saved elsewhere", async ({
  app,
  screen,
}) => {
  // Arrange
  const flowId = await createFlowElsewhere(app.baseUrl, "Saved elsewhere Flow");
  await app.open(`/studio/flows/${flowId}`);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 1");

  // Act
  await renameFlow(app.baseUrl, flowId, "Saved elsewhere Flow renamed");

  // Assert
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 2");
  await expect(screen.getByText("Updated to revision 2.")).toBeVisible();
  await expect(screen.getByLabel("Flow name")).toHaveValue("Saved elsewhere Flow renamed");
});

test("an open Flow editor says its Flow was removed elsewhere and disables Save, Start Run and Remove", async ({
  app,
  screen,
}) => {
  // Arrange
  const flowId = await createFlowElsewhere(app.baseUrl, "Removed Studio Flow");
  await app.open(`/studio/flows/${flowId}`);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Revision 1");

  // Act
  await removeFlowElsewhere(app.baseUrl, flowId);

  // Assert
  await expect(screen.getByText("This Flow was removed elsewhere.", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", "Save Flow")).toBeDisabled();
  await expect(screen.getByRole("button", "Start Run")).toBeDisabled();
  await expect(screen.getByRole("button", "Remove")).toBeDisabled();
  await expect(screen.getByRole("button", "Copy as JSON")).toBeVisible();
});

test("a fresh link to an absent Agent says it was not found and leads back to the list", async ({
  app,
  screen,
}) => {
  // Arrange

  // Act
  await app.open("/studio/agents/no-such-agent");

  // Assert
  await expect(screen.getByText("Agent not found", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Back to list").tap();
  await expect(screen.getByRole("heading", "Agents", { exact: true })).toBeVisible();
});

test("a revision saved elsewhere during a drag waits, and the drop keeps its move against the old revision", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const flowId = await createFlowElsewhere(app.baseUrl, "Deferred Studio Flow");
  await app.open(`/studio/flows/${flowId}`);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 1");
  const handle = (await screen.getByRole("button", "Flow input", { exact: true }).boundingBox())!;
  await browser.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await browser.mouse.down();
  await browser.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2 + 80);
  await renameFlow(app.baseUrl, flowId, "Deferred Studio Flow renamed");
  await expect(screen.getByText("Revision 2 was saved elsewhere.", { exact: false })).toBeVisible();

  // Act
  await browser.mouse.up();

  // Assert
  await expect(screen.getByRole("status", "Flow save status")).toContainText(
    "Unsaved changes · Revision 1",
  );
  await expect(screen.getByText("Revision 2 was saved elsewhere.", { exact: false })).toBeVisible();
  await expect(screen.getByLabel("Flow name")).toHaveValue("Deferred Studio Flow");
});

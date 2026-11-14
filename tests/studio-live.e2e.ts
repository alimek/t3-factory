import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { copyAgentDefinition } from "./support/agents.ts";
import { renameFlow } from "./support/flows.ts";

const mutation = { "content-type": "application/json", "X-Factory-Request": "1" };

/** Another client creates an empty Flow and returns its id. */
async function createFlowElsewhere(baseUrl: string | undefined, name: string) {
  const response = await fetch(new URL("/api/flows", baseUrl), {
    method: "POST",
    headers: mutation,
    body: JSON.stringify({ name }),
  });
  return ((await response.json()) as { value: { id: string } }).value.id;
}

test("an Agent created by another client appears in an open Studio Agents list", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/studio/agents");
  await expect(screen.getByRole("link", "Sample worker", { exact: true })).toBeVisible();

  // Act
  await copyAgentDefinition(app.baseUrl, "Sample worker", "Live Studio Agent");

  // Assert
  await expect(screen.getByRole("link", "Live Studio Agent", { exact: true })).toBeVisible();
});

test("an open Agent editor says its Agent was removed elsewhere and keeps the draft", async ({
  app,
  screen,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Removed Studio Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await screen.getByLabel("Name").fill("Removed Studio Agent draft");

  // Act
  const removed = await fetch(new URL(`/api/agents/${agent.id}`, app.baseUrl), {
    method: "DELETE",
    headers: mutation,
  });

  // Assert
  expect(removed.status).toBe(200);
  await expect(screen.getByText(/This Agent was removed elsewhere/)).toBeVisible();
  await expect(screen.getByRole("link", "Removed Studio Agent", { exact: true })).toHaveCount(0);
  await expect(screen.getByLabel("Name")).toHaveValue("Removed Studio Agent draft");
});

test("an open Flow editor says its Flow was removed elsewhere", async ({ app, screen }) => {
  // Arrange
  const flowId = await createFlowElsewhere(app.baseUrl, "Removed Studio Flow");
  await app.open(`/studio/flows/${flowId}`);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Revision 1");

  // Act
  const removed = await fetch(new URL(`/api/flows/${flowId}`, app.baseUrl), {
    method: "DELETE",
    headers: mutation,
  });

  // Assert
  expect(removed.status).toBe(200);
  await expect(screen.getByText("This Flow was removed elsewhere.", { exact: true })).toBeVisible();
});

test("an open Flow editor without unsaved changes shows a revision saved by another client", async ({
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
  await expect(screen.getByRole("heading", "Saved elsewhere Flow renamed")).toBeAttached();
});

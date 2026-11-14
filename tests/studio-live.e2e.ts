import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { copyAgentDefinition } from "./support/agents.ts";

const mutation = { "content-type": "application/json", "X-Factory-Request": "1" };

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
  const created = (await (
    await fetch(new URL("/api/flows", app.baseUrl), {
      method: "POST",
      headers: mutation,
      body: JSON.stringify({ name: "Removed Studio Flow" }),
    })
  ).json()) as { value: { id: string } };
  await app.open(`/studio/flows/${created.value.id}`);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Revision 1");

  // Act
  const removed = await fetch(new URL(`/api/flows/${created.value.id}`, app.baseUrl), {
    method: "DELETE",
    headers: mutation,
  });

  // Assert
  expect(removed.status).toBe(200);
  await expect(screen.getByText("This Flow was removed elsewhere.", { exact: true })).toBeVisible();
});
